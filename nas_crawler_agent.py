#!/usr/bin/env python3
"""
ModelWiki NAS crawler agent.

Runs on a home NAS/minipc and reverse-polls the server for crawler jobs. It is
designed for sources that benefit from a residential IP and a normal browser
profile. No inbound port or VPN from the server to the NAS is required.
"""

import argparse
import register_images as _reg_img
import os
import socket
import sys
import time
import traceback

import requests

import mfc_batch_scraper as batch
from mfc_batch_scraper import CloudflareBlockError
from crawler_common import (
    JsonlReport,
    resolve_admin_password,
    resolve_admin_user,
    resolve_api_base,
)


SUPPORTED_ITEM_SOURCES = {"mfc", "hobbysearch", "amiami"}
REQUEST_TIMEOUT = 30

# ─── Canonical CrawlerJob status enum (7 values) ────────────────────────────
# Contract: docs/implementation/PHASE12_CONTRACT.md §5
# The ONLY values new writes may use. "succeeded" is forbidden — use "completed".
CRAWLER_JOB_STATUSES = (
    "created",
    "queued",
    "claimed",
    "running",
    "completed",
    "failed",
    "deferred",
)

# Legal state transitions (mirrors mw-backend/src/crawler/stateMachine.ts).
LEGAL_TRANSITIONS = {
    "created": ["queued"],
    "queued": ["claimed"],
    "claimed": ["running", "queued"],
    "running": ["completed", "failed", "deferred"],
    "completed": [],          # terminal
    "failed": ["created"],    # admin retry only
    "deferred": ["queued"],
}

TERMINAL_STATUSES = frozenset({"completed", "failed"})
ACTIVE_STATUSES = frozenset({"created", "queued", "claimed", "running", "deferred"})


class IllegalTransitionError(Exception):
    """Raised when a CrawlerJob status transition violates LEGAL_TRANSITIONS."""

    def __init__(self, from_status, to_status, job_id=None):
        self.from_status = from_status
        self.to_status = to_status
        self.job_id = job_id
        legal = LEGAL_TRANSITIONS.get(from_status, [])
        super().__init__(
            f"Illegal CrawlerJob transition: {from_status} -> {to_status}"
            + (f" (job {job_id})" if job_id else "")
            + f". Legal targets from {from_status}: {legal or '(terminal)'}"
        )


def _assert_legal_transition(from_status, to_status, job_id=None):
    """Validate a status transition against LEGAL_TRANSITIONS.

    Raises IllegalTransitionError if the transition is not allowed.
    """
    if from_status not in LEGAL_TRANSITIONS:
        raise IllegalTransitionError(from_status, to_status, job_id)
    if to_status not in LEGAL_TRANSITIONS[from_status]:
        raise IllegalTransitionError(from_status, to_status, job_id)


def _now_iso():
    """Return current UTC time as ISO 8601 string (e.g. 2026-07-13T12:00:00Z)."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class NasCrawlerAgent:
    def __init__(self, api_base, username, password, runner, worker_id, poll_interval, report_path):
        self.api_base = api_base.rstrip("/")
        self.username = username
        self.password = password
        self.runner = runner
        self.worker_id = worker_id
        self.poll_interval = poll_interval
        self.report = JsonlReport(report_path)
        self.session = requests.Session()
        self.token = None
        self.scrapers = {}
        # Source-level cooldown: when Cloudflare blocks a source, record the
        # time until which all jobs for that source should be deferred.
        # Mapping: source -> ISO 8601 timestamp (UTC) when cooldown ends.
        self.source_blocked_until = {}
        self._stopping = False
        # Transition tracking: last known status and attempt per job_id.
        # Populated by claim_jobs and update_job for transition validation.
        self._last_status = {}
        self._last_attempt = {}
        # Append-only transition event log for audit (previousStatus, nextStatus,
        # agentId, attempt, timestamp, resultSummary/error).
        self._transition_events = []

    def log(self, message):
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)

    def login(self):
        resp = self.session.post(
            f"{self.api_base}/auth/login",
            json={"username": self.username, "password": self.password},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"Login failed: {data}")
        self.token = data["data"]["token"]
        self.session.headers.update({
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        })
        batch.API_BASE = self.api_base
        self.log(f"logged in as {self.username}; runner={self.runner}; worker={self.worker_id}")

    def _ensure_auth(self):
        """Re-login if token expired (401). Called on auth errors."""
        try:
            self.login()
        except Exception as e:
            self.log(f"re-login failed: {type(e).__name__}: {e}")
            raise

    def claim_jobs(self, limit=1, job_ids=None):
        """Atomically claim jobs via the backend claim API.

        All claim logic is server-side (POST /admin/crawler/jobs/claim).
        The Python agent never does queue-wide consumption on its own.

        Args:
            limit: Max jobs to claim (server enforces [1, 10]).
            job_ids: Optional canary-mode allowlist. When provided, the
                request includes ``jobIds`` so the backend claims ONLY those
                ids (contract §5 + §12 canary protocol). Queue-wide claim
                is forbidden in canary mode.
        """
        # Server schema enforces limit in [1, 10]; cap to avoid 422
        claim_limit = max(1, min(int(limit or 1), 10))
        claim_body = {
            "runner": self.runner,
            "workerId": self.worker_id,
            "limit": claim_limit,
        }
        # Canary mode: pass exact jobIds so the backend claims only those.
        if job_ids:
            claim_body["jobIds"] = list(job_ids)
            claim_body["canaryMode"] = True
        try:
            resp = self.session.post(
                f"{self.api_base}/admin/crawler/jobs/claim",
                json=claim_body,
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 401:
                self._ensure_auth()
                resp = self.session.post(
                    f"{self.api_base}/admin/crawler/jobs/claim",
                    json=claim_body,
                    timeout=REQUEST_TIMEOUT,
                )
            if resp.status_code == 422:
                self.log(f"claim 422: {resp.text[:300]} (limit={claim_limit})")
            resp.raise_for_status()
            data = resp.json()
            if not data.get("success"):
                raise RuntimeError(f"Claim failed: {data}")
            claimed = data.get("data", [])
            # Record claimed status for transition validation.
            # The backend transitions queued/deferred -> claimed and increments
            # attempts atomically; we mirror that locally.
            for job in claimed:
                jid = job.get("id")
                if jid:
                    self._last_status[jid] = "claimed"
                    self._last_attempt[jid] = int(job.get("attempts", 0) or 0)
            return claimed
        except requests.HTTPError:
            raise
        except Exception as e:
            if "401" in str(e) or "Unauthorized" in str(e):
                self._ensure_auth()
            raise

    def update_job(self, job_id, **payload):
        """Update a job via the backend API with transition validation.

        Validates the status transition against LEGAL_TRANSITIONS before
        sending. Records a transition event (previousStatus, nextStatus,
        agentId, attempt, timestamp, resultSummary/error) both locally
        (self._transition_events) and in the payload (``transition`` key)
        so the backend can persist it as a CrawlerJobEvent.

        Raises IllegalTransitionError if the transition is not allowed.
        """
        new_status = payload.get("status")
        previous_status = self._last_status.get(job_id)
        attempt_val = payload.get("attempts")
        if attempt_val is None:
            attempt_val = self._last_attempt.get(job_id, 0)

        # Validate transition if both previous and new status are known
        if new_status and previous_status:
            _assert_legal_transition(previous_status, new_status, job_id)

        # Build transition metadata and include it in the payload
        if new_status:
            transition = {
                "previousStatus": previous_status,
                "nextStatus": new_status,
                "agentId": self.worker_id,
                "runner": self.runner,
                "attempt": attempt_val,
                "timestamp": _now_iso(),
            }
            # Include in payload so backend can store as CrawlerJobEvent
            payload["transition"] = transition
            # Record locally for audit/testing
            self._transition_events.append({
                "jobId": job_id,
                "previousStatus": previous_status,
                "nextStatus": new_status,
                "agentId": self.worker_id,
                "attempt": attempt_val,
                "timestamp": transition["timestamp"],
                "resultSummary": payload.get("resultSummary"),
                "error": payload.get("error"),
            })

        import random as _r
        for retry_idx in range(3):
            try:
                resp = self.session.put(
                    f"{self.api_base}/admin/crawler/jobs/{job_id}",
                    json=payload,
                    timeout=REQUEST_TIMEOUT,
                )
                if resp.status_code == 401:
                    self._ensure_auth()
                    resp = self.session.put(
                        f"{self.api_base}/admin/crawler/jobs/{job_id}",
                        json=payload,
                        timeout=REQUEST_TIMEOUT,
                    )
                if resp.status_code == 429:
                    if retry_idx < 2:
                        wait = (2 ** retry_idx) + _r.uniform(0.5, 1.5)
                        self.log(f"  429 on update_job, retry in {wait:.1f}s (attempt {retry_idx+1}/3)")
                        time.sleep(wait)
                        continue
                    raise RuntimeError(f"update_job: 3 consecutive 429, giving up")
                resp.raise_for_status()
                # Update local status tracking on success
                if new_status:
                    self._last_status[job_id] = new_status
                    if payload.get("attempts") is not None:
                        self._last_attempt[job_id] = int(payload["attempts"])
                return resp.json()
            except RuntimeError:
                raise
            except Exception:
                raise

    def create_job(self, payload):
        resp = self.session.post(
            f"{self.api_base}/admin/crawler/jobs",
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def _find_active_job(self, source, task, item_id):
        """Check if there's already an active (non-terminal) job for the given
        source + task + itemId. Used for idempotent job creation.

        Returns the existing job dict or None.
        """
        if not item_id:
            return None
        try:
            resp = self.session.get(
                f"{self.api_base}/admin/crawler/jobs",
                params={"source": source, "limit": 200},
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code != 200:
                return None
            jobs = (resp.json().get("data") or [])
            for j in jobs:
                if j.get("status") not in ACTIVE_STATUSES:
                    continue
                if j.get("task") != task:
                    continue
                j_payload = j.get("payload") or {}
                if j_payload.get("itemId") == item_id or j_payload.get("id") == item_id:
                    return j
        except Exception as e:
            self.log(f"  warn: _find_active_job failed: {e}")
        return None

    def _create_fetch_item_job_idempotent(self, source, task, payload, priority,
                                           automation, discovered_by):
        """Create a fetch_item job, but only if no active job exists for the
        same source + itemId. This prevents duplicate jobs from repeated
        searches (idempotent request_refetch — contract §3 request_refetch
        MUST create exactly one CrawlerJob per active window).

        Returns (job_dict, created: bool).
        """
        item_id = payload.get("itemId") or payload.get("id")
        if item_id:
            existing = self._find_active_job(source, task, item_id)
            if existing:
                self.log(
                    f"  idempotent skip: active job {existing.get('id')} "
                    f"exists for {source}:{item_id}"
                )
                return existing, False
        body = {
            "source": source,
            "task": task,
            "runner": self.runner,
            "priority": priority,
            "payload": payload,
            "automation": automation,
        }
        job = self.create_job(body)
        return job, True

    def _is_source_blocked(self, source):
        """Check if a source is currently in Cloudflare-block cooldown."""
        block_until = self.source_blocked_until.get(source)
        if not block_until:
            return False
        from datetime import datetime, timezone
        try:
            until = datetime.fromisoformat(block_until.replace("Z", "+00:00"))
        except Exception:
            # Bad timestamp - clear it and treat as not blocked
            self.source_blocked_until.pop(source, None)
            return False
        now = datetime.now(timezone.utc)
        if now < until:
            return True
        # Cooldown expired - clear it
        self.source_blocked_until.pop(source, None)
        return False

    def _mark_source_blocked(self, source, minutes=30):
        """Mark a source as Cloudflare-blocked for `minutes` minutes.

        All subsequent fetch_item jobs for this source will be deferred
        without retry until the cooldown expires.
        """
        from datetime import datetime, timedelta, timezone
        until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
        iso = until.strftime("%Y-%m-%dT%H:%M:%SZ")
        self.source_blocked_until[source] = iso
        self.log(f"  source '{source}' blocked by Cloudflare - cooldown until {iso} ({minutes} min)")

    def get_scraper(self, source):
        key = source
        scraper = self.scrapers.get(key)
        if scraper:
            return scraper

        scraper = batch.FigureScraper(
            password=self.password,
            source=source,
            dry_run=False,
            ai_rewrite=os.environ.get("MODELWIKI_AI_KEY", "") != "",
            report_path=self.report.path,
            submit_review=True,
        )
        scraper.login()
        scraper.load_progress()
        scraper.load_manufacturers()
        scraper.load_categories()
        self.scrapers[key] = scraper
        return scraper

    def scrape_item(self, source, item_id):
        scraper = self.get_scraper(source)
        if source == "mfc":
            return scraper.scrape_mfc_item(str(item_id))
        if source == "hobbysearch":
            return scraper.scrape_hobbysearch_item(str(item_id))
        if source == "amiami":
            scraper.start_browser()
            try:
                return scraper.scrape_amiami_item(str(item_id))
            finally:
                scraper.stop_browser()
        raise ValueError(f"Unsupported item source: {source}")

    def _fetch_figure_readback(self, figure_id, slug):
        """Fetch final category slugs and image counts from API after merge.

        Uses GET /figures/{slug} which returns categories[] and images[].
        This is the authoritative DB readback (not scraper-inferred).

        Returns:
          {
            "final_category_slugs": [str, ...],
            "final_db_image_counts": {"detail": N, "thumb": N, "raw": N, "total": N},
          }
        or None on error / when no slug available.
        """
        if not slug:
            return None
        result = {
            "final_category_slugs": [],
            "final_db_image_counts": {"detail": 0, "thumb": 0, "raw": 0, "total": 0},
            "historical_upload_items_present": False,
            "detail_completeness": {
                "description_present": False,
                "specs_present_count": 0,
                "specs_total": 6,
                "detail_incomplete": True,
                "source_missing_fields": [],
            },
        }
        try:
            r = self.session.get(f"{self.api_base}/figures/{slug}", timeout=30)
            if r.status_code != 200:
                self.log(f"  warn: readback figure {slug} status={r.status_code}")
                return None
            body = r.json()
            fig = body.get("data") or body.get("figure") or {}
            # Categories: [{figureId, categoryId, category: {id, slug, name}}]
            cats = fig.get("categories") or []
            for c in cats:
                if not isinstance(c, dict):
                    continue
                cat_obj = c.get("category") or {}
                s = cat_obj.get("slug") if isinstance(cat_obj, dict) else None
                if not s:
                    s = c.get("slug")
                if s:
                    result["final_category_slugs"].append(s)
            # Images: [{size: "detail"|"thumb"|"raw", url, source, ...}]
            imgs = fig.get("images") or []
            upload_items_in_db = False
            for im in imgs:
                if not isinstance(im, dict):
                    continue
                sz = im.get("size")
                if sz == "detail":
                    result["final_db_image_counts"]["detail"] += 1
                elif sz == "thumb":
                    result["final_db_image_counts"]["thumb"] += 1
                elif sz == "raw":
                    result["final_db_image_counts"]["raw"] += 1
                # Historical /upload/items/ detection (any image, any date)
                url_val = str(im.get("url") or "")
                src_val = str(im.get("source") or "")
                if "/upload/items/" in url_val or "/upload/items/" in src_val:
                    upload_items_in_db = True
            result["final_db_image_counts"]["total"] = sum(result["final_db_image_counts"].values())
            result["historical_upload_items_present"] = upload_items_in_db
            # Detail completeness: description + 6 spec fields
            desc_val = fig.get("description") or ""
            result["detail_completeness"]["description_present"] = bool(desc_val and desc_val.strip())
            spec_fields = ["scale", "material", "releaseDate", "priceJpy", "heightMm", "janCode"]
            present = 0
            for sf in spec_fields:
                if fig.get(sf):
                    present += 1
            result["detail_completeness"]["specs_present_count"] = present
            result["detail_completeness"]["detail_incomplete"] = (
                not result["detail_completeness"]["description_present"] and present < 3
            )
            return result
        except Exception as e:
            self.log(f"  warn: readback failed for {slug}: {e}")
            return None

    def _build_result_summary(self, job, source, item_id, batch_id, write_action,
                              result, data, scraper, upload_counts,
                              cf_cleared=False, cf_blocked=False,
                              error_code=None, error_message=None):
        """Build a structured resultSummary dict for writing back to the job JSON.

        Provides Hermes with a compact, queryable summary of what happened for
        this job. Fields are derived from DB/API readback (authoritative), not
        scraper-inferred values:

        - final_category_slugs: from GET /figures/{slug} categories[]
        - final_db_image_counts: from GET /figures/{slug} images[]
        - uploaded_image_counts: this run's upload counts (from _upload_images_via_api)
        - quality_flags: image_zero_count / image_low_count / category_summary_mismatch
                         / thumbnail_only / upload_items_present
        """
        figure_id = result.get("id") if result else None
        slug = result.get("slug") if result else None

        # Scraper-inferred category (prepare_scraped_item.db_category_slug)
        # Used only for category_summary_mismatch detection.
        scraper_category_slugs = []
        if data and data.get("db_category_slug"):
            scraper_category_slugs.append(data["db_category_slug"])

        # This run's upload counts
        counts = upload_counts or {}
        uploaded_detail = counts.get("detail", 0)
        uploaded_thumb = counts.get("thumb", 0)
        uploaded_raw = counts.get("raw", 0)
        uploaded_total = uploaded_detail + uploaded_thumb + uploaded_raw

        # /upload/items/ detection in processed_images
        processed_images = getattr(scraper, "processed_images", []) if scraper else []
        upload_items_count = sum(
            1 for img in processed_images
            if "/upload/items/" in str(img.get("source", ""))
        )
        official_image_count = sum(
            1 for img in processed_images
            if img.get("data", {}).get("source_kind", "").startswith("official_")
        )

        # DB readback (authoritative final state after merge)
        final_category_slugs = []
        final_db_image_counts = {"detail": 0, "thumb": 0, "raw": 0, "total": 0}
        historical_upload_items_present = False
        detail_completeness = {
            "description_present": False,
            "specs_present_count": 0,
            "specs_total": 6,
            "detail_incomplete": True,
            "source_missing_fields": [],
        }
        readback_ok = False
        if figure_id and slug and write_action in ("created", "merged", "skipped"):
            readback = self._fetch_figure_readback(figure_id, slug)
            if readback:
                final_category_slugs = readback["final_category_slugs"]
                final_db_image_counts = readback["final_db_image_counts"]
                historical_upload_items_present = bool(readback.get("historical_upload_items_present"))
                detail_completeness = readback.get("detail_completeness") or detail_completeness
                readback_ok = True

        final_total = final_db_image_counts["total"]
        final_detail = final_db_image_counts["detail"]
        final_thumb = final_db_image_counts["thumb"]

        # category_summary_mismatch: scraper-inferred != DB actual
        category_mismatch = False
        if readback_ok and scraper_category_slugs:
            if sorted(scraper_category_slugs) != sorted(final_category_slugs):
                category_mismatch = True

        # Quality flags
        # upload_items_present: true if this run OR historical DB has /upload/items/
        upload_items_present = (upload_items_count > 0) or historical_upload_items_present
        quality_flags = {
            "image_zero_count": (final_total == 0 and readback_ok),
            "image_low_count": (0 < final_total < 3),
            "category_summary_mismatch": category_mismatch,
            "thumbnail_only": (final_detail == 0 and final_thumb > 0),
            "upload_items_present": upload_items_present,
            "historical_upload_items_present": historical_upload_items_present,
            "detail_incomplete": bool(detail_completeness.get("detail_incomplete")),
            "image_polluted": bool(historical_upload_items_present),
        }

        # MFC image extraction stats (from scraper, if available)
        img_extract_stats = (data or {}).get("_mfc_image_extraction_stats") if data else None

        return {
            "source": source,
            "itemId": item_id,
            "batch_id": batch_id,
            "write_action": write_action,
            "figure_id": figure_id,
            "slug": slug,
            # Whether the DB readback (GET /figures/{slug}) succeeded — used by
            # the 3-step completion verification (HTTP 200 != completed).
            "readback_ok": readback_ok,
            # DB readback (authoritative)
            "final_category_slugs": final_category_slugs,
            "final_db_image_counts": final_db_image_counts,
            # This run's upload counts
            "uploaded_image_counts": {
                "detail": uploaded_detail,
                "thumb": uploaded_thumb,
                "raw": uploaded_raw,
                "total": uploaded_total,
            },
            # Quality flags for Hermes gate
            "quality_flags": quality_flags,
            # Legacy aliases (for backward compat with existing consumers)
            "category_slugs": final_category_slugs,
            "image_counts": {
                "detail": uploaded_detail,
                "thumb": uploaded_thumb,
                "raw": uploaded_raw,
                "total": uploaded_total,
            },
            "upload_items_count": upload_items_count,
            "official_image_count": official_image_count,
            "thumbnail_only": quality_flags["thumbnail_only"],
            "cf_cleared": cf_cleared,
            "cf_blocked": cf_blocked,
            "error_code": error_code,
            "error_message": error_message,
            # MFC browser image extraction stats (Playwright phase A+B)
            "thumbnail_candidates_count": img_extract_stats.get("thumbnail_candidates_count", 0) if img_extract_stats else 0,
            "full_image_candidates_count": img_extract_stats.get("full_image_candidates_count", 0) if img_extract_stats else 0,
            "clicked_thumbnail_count": img_extract_stats.get("clicked_thumbnail_count", 0) if img_extract_stats else 0,
            "modal_open_success_count": img_extract_stats.get("modal_open_success_count", 0) if img_extract_stats else 0,
            "picture_page_success_count": img_extract_stats.get("picture_page_success_count", 0) if img_extract_stats else 0,
            "rejected_thumbnail_count": img_extract_stats.get("rejected_thumbnail_count", 0) if img_extract_stats else 0,
            "final_detail_count": final_db_image_counts["detail"],
            "detail_completeness": detail_completeness,
            "image_relevance_checked_count": img_extract_stats.get("image_relevance_checked_count", 0) if img_extract_stats else 0,
            "image_relevance_pass_count": img_extract_stats.get("image_relevance_pass_count", 0) if img_extract_stats else 0,
            "image_relevance_fail_count": img_extract_stats.get("image_relevance_fail_count", 0) if img_extract_stats else 0,
            "rejected_unrelated_picture_count": img_extract_stats.get("rejected_unrelated_picture_count", 0) if img_extract_stats else 0,
        }

    def handle_fetch_item(self, job):
        source = job.get("source")
        payload = job.get("payload") or {}
        item_id = payload.get("itemId") or payload.get("id")
        batch_id = payload.get("batch_id")
        if not item_id:
            raise ValueError("fetch_item job requires payload.itemId")
        if source not in SUPPORTED_ITEM_SOURCES:
            raise ValueError(f"Unsupported source for fetch_item: {source}")

        # Source-level cooldown: if Cloudflare blocked this source recently,
        # defer the job without retrying or incrementing attempts.
        if self._is_source_blocked(source):
            raise CloudflareBlockError(
                f"source '{source}' is in cooldown until {self.source_blocked_until.get(source)}"
            )

        scraper = self.get_scraper(source)
        scraped = self.scrape_item(source, item_id)
        if not scraped or not scraped.get("name"):
            # Truly unusable data - no name at all. Only this case is filtered=True.
            self.log(f"job {job['id']}: {source}:{item_id} no usable data, filtering")
            self.report.write(
                "agent_fetch_item_filtered",
                jobId=job["id"], source=source, itemId=item_id,
                name="", reason="no_name",
            )
            result_summary = self._build_result_summary(
                job, source, item_id, batch_id, "filtered",
                None, None, scraper, {},
                cf_cleared=False, cf_blocked=False,
                error_code="NO_USABLE_DATA", error_message="no name in scraped data",
            )
            return {
                "source": source,
                "itemId": item_id,
                "name": "",
                "filtered": True,
                "reviewSubmitted": False,
                "resultSummary": result_summary,
            }

        data = scraper.prepare_scraped_item(scraped, source)
        if not data:
            # prepare_scraped_item only returns None when there is no name.
            # This is the real "no usable data" case - do not retry the site.
            self.log(f"job {job['id']}: {source}:{item_id} prepare returned None, filtering")
            self.report.write(
                "agent_fetch_item_filtered",
                jobId=job["id"], source=source, itemId=item_id,
                name=scraped.get("name", ""), reason="prepare_none",
            )
            result_summary = self._build_result_summary(
                job, source, item_id, batch_id, "filtered",
                None, None, scraper, {},
                cf_cleared=False, cf_blocked=False,
                error_code="PREPARE_NONE", error_message="prepare_scraped_item returned None",
            )
            return {
                "source": source,
                "itemId": item_id,
                "name": scraped.get("name", ""),
                "filtered": True,
                "reviewSubmitted": False,
                "resultSummary": result_summary,
            }
        result = scraper.create_or_merge_figure(data)
        # Upload processed images via upload-processed endpoint (bypasses server-side download)
        upload_counts = {"detail": 0, "thumb": 0, "raw": 0, "total": 0, "skipped": 0}
        need_images = (job.get("payload") or {}).get("needImages", False)
        if result and result.get("id") and getattr(scraper, "processed_images", []):
            try:
                upload_counts = self._upload_images_via_api(result["id"], result.get("janCode") or "", scraper.processed_images)
            except Exception as _e:
                self.log(f"image upload FAILED: {_e}")
                if need_images:
                    raise RuntimeError(f"image upload required but function threw: {_e}")
                upload_counts = {"detail": 0, "thumb": 0, "raw": 0, "total": 0, "skipped": 0, "failed": 1, "errors": [str(_e)]}
        if need_images:
            uc = upload_counts
            # Case A: uploads tried but some failed -> never succeeded
            if uc.get("failed", 0) > 0:
                raise RuntimeError(
                    f"image upload required but {uc['failed']}/{uc.get('total',0)+uc['failed']} "
                    f"images failed for figure #{result.get('id')}"
                )
            # Case C: scraper 0 processed images, 0 DB images -> not succeeded
            if uc.get("total", 0) == 0 and uc.get("skipped", 0) == 0 and uc.get("failed", 0) == 0:
                db_images = 0
                slug = result.get("slug") or ""
                if slug:
                    try:
                        r = self.session.get(f"{self.api_base}/figures/{slug}", timeout=30)
                        if r.status_code == 200:
                            fig_body = r.json().get("data") or {}
                            db_images = len(fig_body.get("images") or [])
                    except Exception:
                        pass
                if db_images == 0:
                    raise RuntimeError(
                        f"needImages=true but scraper 0 images and figure #{result.get('id')} has 0 images"
                    )
                self.log(f"  needImages=true, scraper 0 images but figure has {db_images} existing — OK")
        self.report.write("agent_fetch_item", jobId=job["id"], source=source, itemId=item_id, scraped=data, result=result)

        # Determine write_action: created vs merged vs skipped
        write_action = "skipped"
        if result:
            import datetime as _dt
            created_at_str = str(result.get("createdAt", "") or "")
            if created_at_str:
                try:
                    created_at = _dt.datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
                    now = _dt.datetime.now(_dt.timezone.utc)
                    write_action = "created" if (now - created_at).total_seconds() < 60 else "merged"
                except Exception:
                    write_action = "merged"
            else:
                write_action = "merged"

        # MFC CF challenge was solved if we reached here without CloudflareBlockError
        cf_cleared = (source == "mfc")
        result_summary = self._build_result_summary(
            job, source, item_id, batch_id, write_action,
            result, data, scraper, upload_counts,
            cf_cleared=cf_cleared, cf_blocked=False,
        )

        # Upload a candidate image to the review cache (if available)
        if result and result.get("slug") and result.get("janCode"):
            fig_slug = result["slug"]
            jan_dir = result["janCode"]
            try:
                r = self.session.get(
                    f"{self.api_base}/admin/review/items?type=image&status=pending&limit=50",
                    timeout=30,
                )
                if r.status_code == 200:
                    all_items = (r.json().get("data") or [])
                    # Find item whose payload references this figure slug
                    rev = None
                    for item in all_items:
                        payload = item.get("payload") or {}
                        if payload.get("figureSlug") == fig_slug or payload.get("slug") == fig_slug:
                            rev = item
                            break
                    if rev:
                        rev_id = rev.get("id")
                        cand = rev.get("candidateImage") or {}
                        if rev_id and cand.get("source") and not cand.get("cachedUrl"):
                            for proc in (getattr(scraper, "processed_images", []) or []):
                                sha = proc.get("sha256", "")
                                if sha:
                                    path = os.path.join(
                                        os.path.dirname(os.path.abspath(__file__)),
                                        "assets", "figures", jan_dir,
                                        f"{sha}_detail.webp",
                                    )
                                    if os.path.isfile(path):
                                        cached_url = self._upload_candidate_to_cache(rev_id, path)
                                        if cached_url:
                                            self._update_review_item_cached_url(rev_id, cached_url)
                                        break
            except Exception as _e:
                self.log(f"  cache-upload integration: {_e}")

        # Source-specific delay to look human (MFC is stricter due to Cloudflare)
        import random as _r
        if source == "mfc":
            delay = _r.uniform(15.0, 30.0)
        elif source == "amiami":
            delay = _r.uniform(5.0, 10.0)
        else:
            delay = _r.uniform(8.0, 15.0)
        time.sleep(delay)
        return {
            "source": source,
            "itemId": item_id,
            "name": data.get("full_name") or data.get("name"),
            "reviewSubmitted": bool(result),
            "resultSummary": result_summary,
        }

    def handle_mfc_search(self, job):
        payload = job.get("payload") or {}
        query = payload.get("query")
        if not query:
            raise ValueError("search job requires payload.query")
        max_results = int(payload.get("maxResults") or 20)
        scraper = self.get_scraper("mfc")
        scraper.start_browser()
        try:
            results = scraper.search_mfc(query, max_results=max_results)
        finally:
            scraper.stop_browser()

        queued = 0
        for item in results:
            payload = {
                "itemId": item.get("id"),
                "url": item.get("url"),
                "discoveredBy": job.get("id"),
                "query": query,
            }
            _, created = self._create_fetch_item_job_idempotent(
                source="mfc",
                task="fetch_item",
                payload=payload,
                priority=job.get("priority", 1),
                automation=job.get("automation") or {"provider": "manual", "workflow": "nas-agent-search"},
                discovered_by=job.get("id"),
            )
            if created:
                queued += 1

        self.report.write("agent_mfc_search", jobId=job["id"], query=query, results=results, queued=queued)
        return {"query": query, "found": len(results), "queued": queued}

    def handle_amiami_search(self, job):
        """Search AmiAmi and queue fetch_item jobs for each result."""
        payload = job.get("payload") or {}
        query = payload.get("query")
        if not query:
            raise ValueError("search job requires payload.query")
        max_results = int(payload.get("maxResults") or 10)
        scraper = self.get_scraper("amiami")
        scraper.start_browser()
        try:
            results = scraper.search_amiami(query, max_results=max_results)
        finally:
            scraper.stop_browser()

        queued = 0
        for item in results:
            payload = {
                "itemId": item.get("id"),
                "url": item.get("url"),
                "discoveredBy": job.get("id"),
                "query": query,
            }
            _, created = self._create_fetch_item_job_idempotent(
                source="amiami",
                task="fetch_item",
                payload=payload,
                priority=job.get("priority", 1),
                automation=job.get("automation") or {"provider": "manual", "workflow": "nas-agent-amiami-search"},
                discovered_by=job.get("id"),
            )
            if created:
                queued += 1

        self.report.write("agent_amiami_search", jobId=job["id"], query=query, results=results, queued=queued)
        return {"query": query, "found": len(results), "queued": queued}

    def handle_hobbysearch_search(self, job):
        """Search HobbySearch and queue fetch_item jobs for each result."""
        payload = job.get("payload") or {}
        query = payload.get("query")
        if not query:
            raise ValueError("search job requires payload.query")
        max_results = int(payload.get("maxResults") or 10)
        scraper = self.get_scraper("hobbysearch")
        scraper.start_browser()
        try:
            results = scraper.search_hobbysearch(query, max_results=max_results)
        finally:
            scraper.stop_browser()

        queued = 0
        for item in results:
            payload = {
                "itemId": item.get("id"),
                "url": item.get("url"),
                "discoveredBy": job.get("id"),
                "query": query,
            }
            _, created = self._create_fetch_item_job_idempotent(
                source="hobbysearch",
                task="fetch_item",
                payload=payload,
                priority=job.get("priority", 1),
                automation=job.get("automation") or {"provider": "manual", "workflow": "nas-agent-hobbysearch-search"},
                discovered_by=job.get("id"),
            )
            if created:
                queued += 1

        self.report.write("agent_hobbysearch_search", jobId=job["id"], query=query, results=results, queued=queued)
        return {"query": query, "found": len(results), "queued": queued}

    def _verify_completion(self, job, result, result_summary):
        """3-step completion verification (HTTP 200 != completed).

        Before marking a job ``completed``, confirm:
          1. Page/data scrape succeeded (data was obtained or intentionally filtered).
          2. Writeback succeeded (figure created/merged via API).
          3. Readback succeeded (GET /figures/{slug} confirms data is in the DB).

        Returns (ok: bool, reason: str).
        """
        task = job.get("task")
        source = job.get("source")

        # Search jobs: no figure writeback to verify. Completion = search ran.
        if task in ("search", "discover"):
            return True, "search completed"

        # fetch_item jobs: 3-step verification
        if task in ("fetch_item", "item"):
            rs = result_summary or {}
            write_action = rs.get("write_action", "skipped")

            # Step 1: scrape succeeded
            if not result:
                return False, "no result from handle_fetch_item"

            # Filtered items: agent determined no usable data. This is a valid
            # completion — the agent successfully classified the item. No
            # writeback or readback needed.
            if write_action == "filtered":
                return True, "filtered (no usable data — intentional)"

            # Step 2: writeback succeeded (figure was created/merged)
            figure_id = rs.get("figure_id")
            slug = rs.get("slug")
            if not figure_id or not slug:
                return False, "writeback produced no figure_id/slug"

            # Step 3: readback succeeded (figure exists in DB via GET /figures/{slug})
            if not rs.get("readback_ok", False):
                return False, f"readback failed for figure #{figure_id} ({slug})"

            return True, "3-step verification passed"

        # Unknown task type — do not fake success
        return False, f"unknown task type: {task}"

    def process_job(self, job):
        job_id = job["id"]
        task = job.get("task")
        source = job.get("source")
        self.log(f"job {job_id}: {source}/{task}")
        self.update_job(job_id, status="running")

        try:
            if task in ("fetch_item", "item"):
                result = self.handle_fetch_item(job)
            elif source == "mfc" and task in ("search", "discover"):
                result = self.handle_mfc_search(job)
            elif source == "amiami" and task in ("search", "discover"):
                result = self.handle_amiami_search(job)
            elif source == "hobbysearch" and task in ("search", "discover"):
                result = self.handle_hobbysearch_search(job)
            else:
                raise ValueError(f"Unsupported job: {source}/{task}")
        except CloudflareBlockError as cf_err:
            # Cloudflare blocked the source. Defer the job with a notBefore
            # timestamp so the backend claim logic skips it until the cooldown
            # expires. Also restore attempts to the pre-claim value: a CF
            # challenge is a transient source-level block, not a real job
            # failure, and consuming attempts here would exhaust the retry
            # budget after 3 claims and mark the job as permanently failed.
            #
            # Requirement 4: if the source was ALREADY in cooldown (error came
            # from the cooldown check in handle_fetch_item), do NOT extend the
            # cooldown again - that would push it forward on every claim cycle.
            was_in_cooldown = self._is_source_blocked(source)
            if not was_in_cooldown:
                self._mark_source_blocked(source, minutes=30)

            # notBefore = source cooldown end time (already set above or from
            # a previous CF detection). This prevents the backend from
            # re-claiming this job for 30 minutes.
            cooldown_until = self.source_blocked_until.get(source)

            # Restore attempts to pre-claim value. The backend increments
            # attempts at claim time (attempts + 1). We subtract 1 to undo
            # that, so CF challenges do not consume retry budget.
            pre_claim_attempts = max(0, int(job.get("attempts", 1)) - 1)

            self.log(f"job {job_id}: deferred (Cloudflare block): {cf_err}")
            cf_payload = job.get("payload") or {}
            cf_result_summary = self._build_result_summary(
                job, source, cf_payload.get("itemId"), cf_payload.get("batch_id"),
                "deferred", None, None, None, {},
                cf_cleared=False, cf_blocked=True,
                error_code="CLOUDFLARE_BLOCK",
                error_message=f"CloudflareBlock: {cf_err}",
            )
            self.update_job(
                job_id, status="deferred",
                notBefore=cooldown_until,
                attempts=pre_claim_attempts,
                error=f"CloudflareBlock: {cf_err}",
                resultSummary=cf_result_summary,
            )
            self.report.write(
                "agent_job_deferred_cf",
                jobId=job_id, source=source, error=str(cf_err),
                notBefore=cooldown_until,
                attemptsRestoredTo=pre_claim_attempts,
                cooldownExtended=(not was_in_cooldown),
            )
            # Brief pause to avoid claim/defer thrashing a batch of same-source
            # jobs while the source is in cooldown. Clamp to [30, 120] seconds.
            wait = min(max(self.poll_interval, 30), 120)
            self.log(f"job {job_id}: pausing {wait:.0f}s after Cloudflare block")
            time.sleep(wait)
            return

        # Extract resultSummary from fetch_item result (if present)
        result_summary = None
        if isinstance(result, dict) and "resultSummary" in result:
            result_summary = result.pop("resultSummary")

        # 3-step completion verification (HTTP 200 != completed).
        # Only mark completed when scrape + writeback + readback all succeed.
        ok, reason = self._verify_completion(job, result, result_summary)
        if not ok:
            self.log(f"job {job_id}: completion verification FAILED: {reason}")
            fail_payload = job.get("payload") or {}
            fail_summary = self._build_result_summary(
                job, source, fail_payload.get("itemId"), fail_payload.get("batch_id"),
                "verify_failed", None, None, None, {},
                cf_cleared=False, cf_blocked=False,
                error_code="COMPLETION_VERIFY_FAILED", error_message=reason,
            )
            self.update_job(
                job_id, status="failed",
                error=f"completion verification failed: {reason}",
                resultSummary=fail_summary,
            )
            self.report.write(
                "agent_job_verify_failed",
                jobId=job_id, source=source, reason=reason,
            )
            return

        self.update_job(job_id, status="completed", result=result, resultSummary=result_summary, error="")
        self.log(f"job {job_id}: completed")

    def _upload_images_via_api(self, figure_id, jan_code, processed_images):
        """Upload locally-processed WebP images via /figures/images/upload-processed.

        Before uploading, queries the server for images already attached to this
        figure and skips any (sha256, size) pairs that already exist. This prevents
        the same image from being uploaded many times when a figure is merged
        repeatedly across multiple search jobs.
        """
        import base64 as _b64
        import random as _r
        from PIL import Image as _PILImg
        # self.session already has Authorization header from login()

        # --- Fetch existing image keys for this figure to skip duplicates ---
        existing_keys = set()
        try:
            r = self.session.get(
                f"{self.api_base}/figures/{figure_id}/images",
                timeout=30,
            )
            if r.status_code == 200:
                body = r.json()
                imgs = body.get("data") or body.get("images") or []
                for im in imgs:
                    sha = im.get("sha256") or im.get("sha")
                    sz = im.get("size")
                    if sha and sz:
                        existing_keys.add((sha, sz))
            if existing_keys:
                self.log(f"  figure #{figure_id} already has {len(existing_keys)} image keys; will skip dupes")
        except Exception as e:
            self.log(f"  warn: could not fetch existing images for #{figure_id}: {e}")

        uploaded = 0
        skipped = 0
        failed = 0
        errors = []
        uploaded_by_size = {"detail": 0, "thumb": 0}
        for proc in processed_images:
            sha256 = proc.get("sha256", "")
            jan_dir = jan_code or "no-jancode"
            for size_name in ("detail", "thumb"):
                # Skip if this (sha256, size) already exists on the figure
                if sha256 and (sha256, size_name) in existing_keys:
                    skipped += 1
                    continue
                if not sha256:
                    continue
                path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "figures", jan_dir, f"{sha256}_{size_name}.webp")
                if not os.path.exists(path):
                    continue
                try:
                    with open(path, "rb") as f:
                        content_b64 = _b64.b64encode(f.read()).decode("ascii")
                    img = _PILImg.open(path)
                    w, h = img.size
                    img.close()
                    # Defense-in-depth: reject suspicious aspect ratio images
                    # (banner/strip images like 800x120) even if scraper missed.
                    _min_side = min(w, h)
                    if _min_side > 0 and (max(w, h) / float(_min_side)) > 4.0:
                        self.log(f"  rejecting suspicious aspect ratio image ({w}x{h}) for figure #{figure_id}")
                        skipped += 1
                        continue
                    payload = {
                        "figureId": figure_id,
                        "janCode": jan_dir,
                        "sha256": sha256,
                        "size": size_name,
                        "format": "webp",
                        "width": w,
                        "height": h,
                        "fileSize": os.path.getsize(path),
                        "source": proc.get("source", ""),
                        "sortOrder": proc.get("sort_order", 0),
                        "contentBase64": content_b64,
                        "data": proc.get("data", None),
                    }
                    # Retry loop with exponential backoff for 429 rate limits
                    import random as _r
                    for attempt in range(4):
                        try:
                            resp = self.session.post(f"{self.api_base}/figures/images/upload-processed",
                                                     json=payload, timeout=60)
                        except requests.RequestException as net_err:
                            self.log(f"  image upload {size_name} net err: {net_err}; retry in {2**attempt}s")
                            time.sleep(2 ** attempt + _r.uniform(0.3, 0.8))
                            continue
                        if resp.status_code in (200, 201):
                            uploaded += 1
                            uploaded_by_size[size_name] += 1
                            break
                        if resp.status_code == 429:
                            wait = (2 ** attempt) + _r.uniform(1.5, 3.0)
                            self.log(f"  image upload {size_name} 429, retry in {wait:.1f}s (attempt {attempt+1}/4)")
                            time.sleep(wait)
                            continue
                        if "figure_images_figure_sha256_size_key" in resp.text:
                            uploaded += 1
                            uploaded_by_size[size_name] += 1
                            break
                        self.log(f"  image upload {size_name} failed: {resp.status_code} {resp.text[:150]}")
                        failed += 1
                        errors.append({"size": size_name, "sha256": sha256, "status": resp.status_code, "text": resp.text[:100]})
                        break
                    # Throttle between uploads to avoid triggering 429 in the first place
                    time.sleep(2.0 + _r.uniform(0.3, 1.2))
                except Exception as e:
                    self.log(f"  image upload error {size_name}: {e}")
                    failed += 1
                    errors.append({"size": size_name, "sha256": sha256, "error": str(e)[:100]})
        if uploaded or skipped or failed:
            self.log(f"  uploaded {uploaded} image variants for figure #{figure_id} (skipped {skipped} dupes, failed {failed})")
        return {
            "detail": uploaded_by_size.get("detail", 0),
            "thumb": uploaded_by_size.get("thumb", 0),
            "raw": 0,
            "total": uploaded,
            "skipped": skipped,
            "failed": failed,
            "errors": errors,
        }

    def _upload_candidate_to_cache(self, review_id, image_path):
        """Upload a locally-processed candidate image to the review cache.

        Reads the image file, sends it to POST /admin/review/cache-candidate,
        obtains a signed cachedUrl, then updates the review item to store it.

        Returns the cached URL string, or None on failure.
        """
        if not os.path.isfile(image_path):
            self.log(f"  cache-upload: file not found: {image_path}")
            return None
        import base64 as _b64
        import hashlib as _hl
        with open(image_path, "rb") as _f:
            buf = _f.read()
        b64_data = _b64.b64encode(buf).decode()
        sha = _hl.sha256(buf).hexdigest()
        # Determine extension from actual content
        ext = "jpg"
        if buf[:4] == b"\x89PNG":
            ext = "png"
        elif buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
            ext = "webp"
        try:
            resp = self.session.post(
                f"{self.api_base}/admin/review/cache-candidate",
                json={
                    "reviewId": str(review_id),
                    "hash": sha,
                    "contentBase64": b64_data,
                    "ext": ext,
                },
                timeout=60,
            )
            if resp.status_code != 201:
                self.log(f"  cache-upload failed: {resp.status_code} {resp.text[:200]}")
                return None
            body = resp.json()
            cached_url = (body.get("data") or {}).get("url", "")
            if not cached_url:
                self.log(f"  cache-upload: no url in response: {resp.text[:200]}")
                return None
            self.log(f"  cache-upload OK: {cached_url[:80]}...")
            return cached_url
        except Exception as e:
            self.log(f"  cache-upload error: {type(e).__name__}: {e}")
            return None

    def _update_review_item_cached_url(self, review_item_id, cached_url):
        """Update a review item's candidateImage.cachedUrl."""
        try:
            # First fetch the current item to get existing candidateImage
            resp = self.session.get(
                f"{self.api_base}/admin/review/items/{review_item_id}",
                timeout=30,
            )
            if resp.status_code != 200:
                self.log(f"  review-get failed: {resp.status_code}")
                return False
            item = (resp.json().get("data") or {})
            candidate = item.get("candidateImage") or {}
            if not candidate.get("source"):
                self.log(f"  review item {review_item_id} has no candidateImage.source")
                return False
            candidate["cachedUrl"] = cached_url
            candidate["url"] = candidate.get("url") or candidate["source"]
            resp = self.session.put(
                f"{self.api_base}/admin/review/items/{review_item_id}",
                json={"candidateImage": candidate},
                timeout=30,
            )
            if resp.status_code != 200:
                self.log(f"  review-update failed: {resp.status_code} {resp.text[:200]}")
                return False
            self.log(f"  review item {review_item_id}: cachedUrl set")
            return True
        except Exception as e:
            self.log(f"  review-update error: {type(e).__name__}: {e}")
            return False

    def _cleanup(self):
        """Clean up resources on shutdown."""
        for source, scraper in self.scrapers.items():
            try:
                scraper.stop_browser()
            except Exception as e:
                self.log(f"cleanup: failed to stop {source} browser: {e}")

    def run(self, once=False, limit=1):
        self.login()
        while not self._stopping:
            try:
                jobs = self.claim_jobs(limit=limit)
                if not jobs:
                    if once:
                        self.log("no jobs")
                        return
                    time.sleep(self.poll_interval)
                    continue

                for job in jobs:
                    if self._stopping:
                        # Release claimed jobs back to queued so they can be
                        # re-claimed by another agent. claimed → queued is the
                        # legal transition (claimed → deferred is NOT allowed).
                        try:
                            self.update_job(job["id"], status="queued", error="agent shutting down")
                        except Exception:
                            pass
                        break
                    try:
                        self.process_job(job)
                    except Exception as exc:
                        error = f"{type(exc).__name__}: {exc}"
                        self.log(f"job {job.get('id')}: failed: {error}")
                        self.report.write("agent_job_failed", jobId=job.get("id"), error=error, traceback=traceback.format_exc())
                        current_attempts = job.get("attempts", 0) + 1
                        max_attempts = job.get("maxAttempts", 3)
                        status = "deferred" if current_attempts < max_attempts else "failed"
                        fail_payload = job.get("payload") or {}
                        fail_source = job.get("source")
                        fail_result_summary = self._build_result_summary(
                            job, fail_source, fail_payload.get("itemId"), fail_payload.get("batch_id"),
                            status, None, None, None, {},
                            cf_cleared=False, cf_blocked=False,
                            error_code=type(exc).__name__,
                            error_message=str(exc),
                        )
                        try:
                            self.update_job(job["id"], status=status, error=error, attempts=current_attempts, resultSummary=fail_result_summary)
                        except Exception:
                            pass

                if once:
                    return
            except KeyboardInterrupt:
                self.log("stopped (KeyboardInterrupt)")
                self._cleanup()
                return
            except Exception as exc:
                self.log(f"agent loop error: {type(exc).__name__}: {exc}")
                if once:
                    self._cleanup()
                    raise
                time.sleep(max(self.poll_interval, 10))
        self.log("agent stopped")
        self._cleanup()


def parse_args():
    parser = argparse.ArgumentParser(description="ModelWiki NAS crawler agent")
    parser.add_argument("--api-base", default=resolve_api_base(), help="ModelWiki API base URL")
    parser.add_argument("--username", default=resolve_admin_user(), help="Admin username/email")
    parser.add_argument("--password", default=resolve_admin_password(), help="Admin password")
    parser.add_argument("--runner", default="local_browser", choices=["local_browser", "proxy_browser", "server_safe"], help="Runner queue to claim")
    parser.add_argument("--worker-id", default=f"nas-{socket.gethostname()}-{os.getpid()}", help="Stable worker id")
    parser.add_argument("--poll-interval", type=int, default=30, help="Seconds between empty polls")
    parser.add_argument("--limit", type=int, default=1, help="Max jobs to claim per poll")
    parser.add_argument("--once", action="store_true", help="Claim once and exit")
    parser.add_argument("--report", default=None, help="JSONL report path")
    return parser.parse_args()


def main():
    args = parse_args()
    agent = NasCrawlerAgent(
        api_base=args.api_base,
        username=args.username,
        password=args.password,
        runner=args.runner,
        worker_id=args.worker_id,
        poll_interval=args.poll_interval,
        report_path=args.report,
    )
    try:
        agent.run(once=args.once, limit=args.limit)
    except Exception as exc:
        print(f"fatal: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
