#!/usr/bin/env python3
"""
Tests for the Crawler state machine in nas_crawler_agent.py.

Covers:
  - Legal/illegal status transitions (LEGAL_TRANSITIONS)
  - Atomic claim via backend API (canary mode with jobIds)
  - Duplicate claim prevention (claimed jobs can't be re-claimed)
  - Failure retry path (failed -> created -> queued -> claimed)
  - Writeback failure -> NOT completed (3-step verification)
  - "succeeded" is forbidden as a status value
  - Transition metadata recording (previousStatus, nextStatus, agentId, ...)
  - Idempotent job creation
  - Deferred handling preserves error

All HTTP requests are mocked — no production site access.
"""

import os
import sys
import types
import unittest
from unittest.mock import MagicMock

# ─── Mock missing modules before importing nas_crawler_agent ─────────────────
# The agent imports register_images, crawler_common, and mfc_batch_scraper,
# which may not be available in the test environment.

_mod_reg_img = types.ModuleType("register_images")
sys.modules["register_images"] = _mod_reg_img

_mod_crawler_common = types.ModuleType("crawler_common")


class _JsonlReport:
    def __init__(self, path):
        self.path = path or ":memory:"

    def write(self, event, **kwargs):
        pass


_mod_crawler_common.JsonlReport = _JsonlReport
_mod_crawler_common.resolve_admin_password = lambda: "test-pass"
_mod_crawler_common.resolve_admin_user = lambda: "test-user"
_mod_crawler_common.resolve_api_base = lambda: "http://localhost:3000"
sys.modules["crawler_common"] = _mod_crawler_common

_mod_mfc = types.ModuleType("mfc_batch_scraper")


class CloudflareBlockError(Exception):
    pass


_mod_mfc.CloudflareBlockError = CloudflareBlockError
_mod_mfc.FigureScraper = MagicMock
_mod_mfc.API_BASE = "http://localhost:3000"
sys.modules["mfc_batch_scraper"] = _mod_mfc

# Ensure the worktree root is on sys.path
_WORKTREE = os.path.dirname(os.path.abspath(__file__))
if _WORKTREE not in sys.path:
    sys.path.insert(0, _WORKTREE)

import nas_crawler_agent as agent_mod
from nas_crawler_agent import (
    NasCrawlerAgent,
    IllegalTransitionError,
    LEGAL_TRANSITIONS,
    CRAWLER_JOB_STATUSES,
    TERMINAL_STATUSES,
    ACTIVE_STATUSES,
    _assert_legal_transition,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _make_agent():
    """Create a NasCrawlerAgent with a mocked requests.Session."""
    agent = NasCrawlerAgent(
        api_base="http://localhost:3000",
        username="test-user",
        password="test-pass",
        runner="local_browser",
        worker_id="test-worker-1",
        poll_interval=1,
        report_path=None,
    )
    agent.session = MagicMock()
    agent.session.headers = {}
    agent.token = "fake-token"
    return agent


def _mock_response(status_code=200, json_data=None, text=""):
    """Create a mock HTTP response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = text or ""
    resp.json.return_value = json_data or {"success": True, "data": None}
    resp.raise_for_status = MagicMock()
    if status_code >= 400:
        resp.raise_for_status.side_effect = Exception(f"HTTP {status_code}")
    return resp


# ─── Tests ───────────────────────────────────────────────────────────────────

class TestCanonicalStatuses(unittest.TestCase):
    """Test that the 7 canonical statuses are defined correctly."""

    def test_seven_canonical_statuses(self):
        self.assertEqual(len(CRAWLER_JOB_STATUSES), 7)
        for s in ("created", "queued", "claimed", "running",
                   "completed", "failed", "deferred"):
            self.assertIn(s, CRAWLER_JOB_STATUSES)

    def test_succeeded_not_in_statuses(self):
        self.assertNotIn("succeeded", CRAWLER_JOB_STATUSES)

    def test_completed_in_statuses(self):
        self.assertIn("completed", CRAWLER_JOB_STATUSES)


class TestLegalTransitions(unittest.TestCase):
    """Test legal and illegal state transitions."""

    def test_queued_cannot_directly_completed(self):
        """queued -> completed is illegal."""
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("queued", "completed", "job-1")

    def test_claimed_cannot_directly_completed(self):
        """claimed -> completed is illegal (must go through running)."""
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("claimed", "completed", "job-1")

    def test_queued_to_claimed_is_legal(self):
        _assert_legal_transition("queued", "claimed", "job-1")

    def test_claimed_to_running_is_legal(self):
        _assert_legal_transition("claimed", "running", "job-1")

    def test_running_to_completed_is_legal(self):
        _assert_legal_transition("running", "completed", "job-1")

    def test_running_to_failed_is_legal(self):
        _assert_legal_transition("running", "failed", "job-1")

    def test_running_to_deferred_is_legal(self):
        _assert_legal_transition("running", "deferred", "job-1")

    def test_failed_to_created_is_legal(self):
        _assert_legal_transition("failed", "created", "job-1")

    def test_completed_is_terminal(self):
        self.assertEqual(LEGAL_TRANSITIONS["completed"], [])

    def test_claimed_to_deferred_is_illegal(self):
        """claimed -> deferred is NOT legal (release to queued or start running)."""
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("claimed", "deferred", "job-1")

    def test_completed_to_running_is_illegal(self):
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("completed", "running", "job-1")

    def test_failed_to_queued_is_illegal(self):
        """failed -> queued is illegal (must go through created first)."""
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("failed", "queued", "job-1")

    def test_deferred_to_queued_is_legal(self):
        _assert_legal_transition("deferred", "queued", "job-1")

    def test_deferred_to_completed_is_illegal(self):
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("deferred", "completed", "job-1")


class TestUpdateJobTransitionValidation(unittest.TestCase):
    """Test that update_job validates transitions and records metadata."""

    def test_legal_transition_running_to_completed(self):
        agent = _make_agent()
        job_id = "job-100"
        agent._last_status[job_id] = "running"
        agent._last_attempt[job_id] = 1
        agent.session.put.return_value = _mock_response(
            200, {"success": True, "data": {"id": job_id, "status": "completed"}}
        )
        agent.update_job(job_id, status="completed", result={"id": 1})
        self.assertEqual(agent._last_status[job_id], "completed")
        self.assertEqual(len(agent._transition_events), 1)
        event = agent._transition_events[0]
        self.assertEqual(event["previousStatus"], "running")
        self.assertEqual(event["nextStatus"], "completed")
        self.assertEqual(event["agentId"], "test-worker-1")
        self.assertIn("timestamp", event)

    def test_illegal_transition_queued_to_completed_raises(self):
        agent = _make_agent()
        job_id = "job-101"
        agent._last_status[job_id] = "queued"
        with self.assertRaises(IllegalTransitionError):
            agent.update_job(job_id, status="completed")
        agent.session.put.assert_not_called()

    def test_illegal_transition_claimed_to_deferred_raises(self):
        agent = _make_agent()
        job_id = "job-102"
        agent._last_status[job_id] = "claimed"
        with self.assertRaises(IllegalTransitionError):
            agent.update_job(job_id, status="deferred")
        agent.session.put.assert_not_called()

    def test_transition_metadata_in_payload(self):
        """The transition metadata should be included in the PUT payload."""
        agent = _make_agent()
        job_id = "job-103"
        agent._last_status[job_id] = "running"
        agent._last_attempt[job_id] = 2
        agent.session.put.return_value = _mock_response(
            200, {"success": True, "data": {"id": job_id, "status": "failed"}}
        )
        agent.update_job(job_id, status="failed", error="test error", attempts=2)
        call_args = agent.session.put.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        self.assertIn("transition", payload)
        transition = payload["transition"]
        self.assertEqual(transition["previousStatus"], "running")
        self.assertEqual(transition["nextStatus"], "failed")
        self.assertEqual(transition["agentId"], "test-worker-1")
        self.assertEqual(transition["attempt"], 2)
        self.assertIn("timestamp", transition)

    def test_no_previous_status_skips_validation(self):
        """When previous status is unknown, validation is skipped."""
        agent = _make_agent()
        job_id = "job-104"
        agent.session.put.return_value = _mock_response(
            200, {"success": True, "data": {"id": job_id, "status": "running"}}
        )
        agent.update_job(job_id, status="running")
        self.assertEqual(agent._last_status[job_id], "running")

    def test_transition_event_records_result_summary(self):
        """Transition events should capture resultSummary and error."""
        agent = _make_agent()
        job_id = "job-105"
        agent._last_status[job_id] = "running"
        agent.session.put.return_value = _mock_response(200)
        rs = {"write_action": "created", "figure_id": 42}
        agent.update_job(job_id, status="completed", resultSummary=rs, error="")
        event = agent._transition_events[-1]
        self.assertEqual(event["resultSummary"], rs)
        self.assertEqual(event["error"], "")


class TestClaimJobs(unittest.TestCase):
    """Test atomic claim via backend API."""

    def test_claim_records_claimed_status(self):
        agent = _make_agent()
        claimed_job = {
            "id": "job-200",
            "status": "claimed",
            "attempts": 1,
            "source": "mfc",
            "task": "fetch_item",
        }
        agent.session.post.return_value = _mock_response(
            200, {"success": True, "data": [claimed_job]}
        )
        jobs = agent.claim_jobs(limit=1)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(agent._last_status["job-200"], "claimed")
        self.assertEqual(agent._last_attempt["job-200"], 1)

    def test_canary_mode_passes_job_ids(self):
        """Canary mode should include jobIds and canaryMode in the request."""
        agent = _make_agent()
        agent.session.post.return_value = _mock_response(
            200, {"success": True, "data": []}
        )
        agent.claim_jobs(limit=1, job_ids=["job-canary-1", "job-canary-2"])
        call_args = agent.session.post.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json")
        self.assertIn("jobIds", body)
        self.assertEqual(body["jobIds"], ["job-canary-1", "job-canary-2"])
        self.assertTrue(body["canaryMode"])

    def test_no_canary_mode_without_job_ids(self):
        """Without job_ids, canaryMode should not be set."""
        agent = _make_agent()
        agent.session.post.return_value = _mock_response(
            200, {"success": True, "data": []}
        )
        agent.claim_jobs(limit=1)
        call_args = agent.session.post.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json")
        self.assertNotIn("jobIds", body)
        self.assertNotIn("canaryMode", body)

    def test_claimed_job_cannot_be_reclaimed(self):
        """A claimed job cannot transition directly to claimed again."""
        agent = _make_agent()
        job_id = "job-201"
        agent._last_status[job_id] = "claimed"
        with self.assertRaises(IllegalTransitionError):
            agent.update_job(job_id, status="claimed")


class TestFailureRetryPath(unittest.TestCase):
    """Test the failure retry path: failed -> created -> queued -> claimed."""

    def test_full_retry_path_legal(self):
        _assert_legal_transition("failed", "created")
        _assert_legal_transition("created", "queued")
        _assert_legal_transition("queued", "claimed")

    def test_retry_path_via_update_job(self):
        """Test the retry path through update_job with status tracking."""
        agent = _make_agent()
        job_id = "job-300"
        agent.session.put.return_value = _mock_response(
            200, {"success": True, "data": {"id": job_id}}
        )
        # failed -> created
        agent._last_status[job_id] = "failed"
        agent.update_job(job_id, status="created")
        self.assertEqual(agent._last_status[job_id], "created")
        # created -> queued
        agent.update_job(job_id, status="queued")
        self.assertEqual(agent._last_status[job_id], "queued")
        # queued -> claimed
        agent.update_job(job_id, status="claimed")
        self.assertEqual(agent._last_status[job_id], "claimed")
        # claimed -> running
        agent.update_job(job_id, status="running")
        self.assertEqual(agent._last_status[job_id], "running")
        # running -> completed
        agent.update_job(job_id, status="completed")
        self.assertEqual(agent._last_status[job_id], "completed")

    def test_retry_skips_queued_directly(self):
        """failed -> queued is illegal, must go through created."""
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("failed", "queued")


class TestWritebackVerification(unittest.TestCase):
    """Test that writeback failure prevents completed status (HTTP 200 != completed)."""

    def test_readback_failure_prevents_completed(self):
        agent = _make_agent()
        job = {"id": "job-400", "task": "fetch_item", "source": "mfc"}
        result = {"source": "mfc", "itemId": "123", "name": "Test Figure"}
        result_summary = {
            "write_action": "created",
            "figure_id": 42,
            "slug": "test-figure",
            "readback_ok": False,
        }
        ok, reason = agent._verify_completion(job, result, result_summary)
        self.assertFalse(ok)
        self.assertIn("readback", reason.lower())

    def test_no_figure_id_prevents_completed(self):
        agent = _make_agent()
        job = {"id": "job-401", "task": "fetch_item", "source": "mfc"}
        result = {"source": "mfc", "itemId": "123"}
        result_summary = {
            "write_action": "created",
            "figure_id": None,
            "slug": None,
            "readback_ok": False,
        }
        ok, reason = agent._verify_completion(job, result, result_summary)
        self.assertFalse(ok)

    def test_successful_3step_verification(self):
        agent = _make_agent()
        job = {"id": "job-402", "task": "fetch_item", "source": "mfc"}
        result = {"source": "mfc", "itemId": "123", "name": "Test"}
        result_summary = {
            "write_action": "created",
            "figure_id": 42,
            "slug": "test-figure",
            "readback_ok": True,
        }
        ok, reason = agent._verify_completion(job, result, result_summary)
        self.assertTrue(ok)

    def test_filtered_item_completes(self):
        """Filtered items (no usable data) should pass verification."""
        agent = _make_agent()
        job = {"id": "job-403", "task": "fetch_item", "source": "mfc"}
        result = {"source": "mfc", "itemId": "123", "filtered": True}
        result_summary = {
            "write_action": "filtered",
            "figure_id": None,
            "slug": None,
            "readback_ok": False,
            "error_code": "NO_USABLE_DATA",
        }
        ok, reason = agent._verify_completion(job, result, result_summary)
        self.assertTrue(ok)

    def test_search_job_completes_without_writeback(self):
        """Search jobs don't need writeback verification."""
        agent = _make_agent()
        job = {"id": "job-404", "task": "search", "source": "mfc"}
        result = {"query": "test", "found": 5, "queued": 5}
        ok, reason = agent._verify_completion(job, result, None)
        self.assertTrue(ok)

    def test_process_job_marks_failed_on_readback_failure(self):
        """When readback fails, process_job marks the job as failed, NOT completed."""
        agent = _make_agent()
        job = {
            "id": "job-405",
            "task": "fetch_item",
            "source": "mfc",
            "payload": {"itemId": "123"},
            "attempts": 1,
        }
        agent._last_status["job-405"] = "claimed"

        update_calls = []

        def mock_update(jid, **payload):
            update_calls.append((jid, payload))
            if "status" in payload:
                agent._last_status[jid] = payload["status"]
            return {"success": True}

        agent.update_job = mock_update

        def mock_handle(j):
            return {
                "source": "mfc",
                "itemId": "123",
                "name": "Test",
                "resultSummary": {
                    "write_action": "created",
                    "figure_id": 42,
                    "slug": "test-figure",
                    "readback_ok": False,
                },
            }

        agent.handle_fetch_item = mock_handle
        agent._build_result_summary = MagicMock(return_value={
            "write_action": "verify_failed",
            "error_code": "COMPLETION_VERIFY_FAILED",
        })
        agent.report = MagicMock()

        agent.process_job(job)

        statuses = [p.get("status") for _, p in update_calls]
        self.assertIn("running", statuses)
        self.assertIn("failed", statuses)
        self.assertNotIn("completed", statuses)

    def test_process_job_marks_completed_on_success(self):
        """When all 3 steps pass, process_job marks the job as completed."""
        agent = _make_agent()
        job = {
            "id": "job-406",
            "task": "fetch_item",
            "source": "mfc",
            "payload": {"itemId": "123"},
            "attempts": 1,
        }
        agent._last_status["job-406"] = "claimed"

        update_calls = []

        def mock_update(jid, **payload):
            update_calls.append((jid, payload))
            if "status" in payload:
                agent._last_status[jid] = payload["status"]
            return {"success": True}

        agent.update_job = mock_update

        def mock_handle(j):
            return {
                "source": "mfc",
                "itemId": "123",
                "name": "Test",
                "resultSummary": {
                    "write_action": "created",
                    "figure_id": 42,
                    "slug": "test-figure",
                    "readback_ok": True,
                },
            }

        agent.handle_fetch_item = mock_handle
        agent.report = MagicMock()

        agent.process_job(job)

        statuses = [p.get("status") for _, p in update_calls]
        self.assertIn("running", statuses)
        self.assertIn("completed", statuses)
        self.assertNotIn("failed", statuses)


class TestSucceededProhibited(unittest.TestCase):
    """Test that 'succeeded' is never used as a status value in the source code."""

    def test_no_succeeded_status_in_source(self):
        """The source file must not contain status='succeeded' in code."""
        source_path = os.path.join(_WORKTREE, "nas_crawler_agent.py")
        with open(source_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn('status="succeeded"', content)
        self.assertNotIn("status='succeeded'", content)
        self.assertNotIn('status = "succeeded"', content)
        self.assertNotIn("status = 'succeeded'", content)

    def test_completed_is_used_in_source(self):
        """The source file must use 'completed' as a status value."""
        source_path = os.path.join(_WORKTREE, "nas_crawler_agent.py")
        with open(source_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn('status="completed"', content)

    def test_succeeded_not_in_canonical_statuses(self):
        self.assertNotIn("succeeded", CRAWLER_JOB_STATUSES)
        self.assertIn("completed", CRAWLER_JOB_STATUSES)

    def test_succeeded_not_in_legal_transitions(self):
        self.assertNotIn("succeeded", LEGAL_TRANSITIONS)


class TestIdempotentJobCreation(unittest.TestCase):
    """Test that idempotent job creation prevents duplicates."""

    def test_creates_job_when_no_active_exists(self):
        agent = _make_agent()
        agent._find_active_job = MagicMock(return_value=None)
        agent.create_job = MagicMock(return_value={"id": "new-job-1"})

        job, created = agent._create_fetch_item_job_idempotent(
            source="mfc",
            task="fetch_item",
            payload={"itemId": "123"},
            priority=1,
            automation={"provider": "manual"},
            discovered_by="search-1",
        )
        self.assertTrue(created)
        self.assertEqual(job["id"], "new-job-1")
        agent.create_job.assert_called_once()

    def test_skips_creation_when_active_job_exists(self):
        agent = _make_agent()
        existing_job = {"id": "existing-job-1", "status": "queued"}
        agent._find_active_job = MagicMock(return_value=existing_job)
        agent.create_job = MagicMock()

        job, created = agent._create_fetch_item_job_idempotent(
            source="mfc",
            task="fetch_item",
            payload={"itemId": "123"},
            priority=1,
            automation={"provider": "manual"},
            discovered_by="search-1",
        )
        self.assertFalse(created)
        self.assertEqual(job["id"], "existing-job-1")
        agent.create_job.assert_not_called()

    def test_find_active_job_queries_backend(self):
        """_find_active_job should query GET /admin/crawler/jobs and filter by active status."""
        agent = _make_agent()
        agent.session.get.return_value = _mock_response(
            200,
            {"success": True, "data": [
                {"id": "j1", "status": "queued", "task": "fetch_item",
                 "payload": {"itemId": "123"}},
                {"id": "j2", "status": "completed", "task": "fetch_item",
                 "payload": {"itemId": "456"}},
            ]},
        )
        result = agent._find_active_job("mfc", "fetch_item", "123")
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "j1")
        # The completed job should NOT be returned (terminal)
        result2 = agent._find_active_job("mfc", "fetch_item", "456")
        self.assertIsNone(result2)

    def test_find_active_job_skips_wrong_task(self):
        """_find_active_job should only match jobs with the same task."""
        agent = _make_agent()
        agent.session.get.return_value = _mock_response(
            200,
            {"success": True, "data": [
                {"id": "j1", "status": "queued", "task": "search",
                 "payload": {"itemId": "123"}},
            ]},
        )
        result = agent._find_active_job("mfc", "fetch_item", "123")
        self.assertIsNone(result)


class TestDeferredHandling(unittest.TestCase):
    """Test deferred status handling."""

    def test_deferred_preserves_error(self):
        """When deferring, the error field should be populated."""
        agent = _make_agent()
        job_id = "job-500"
        agent._last_status[job_id] = "running"
        agent.session.put.return_value = _mock_response(
            200, {"success": True, "data": {"id": job_id, "status": "deferred"}}
        )
        agent.update_job(
            job_id, status="deferred",
            error="CloudflareBlock: challenge failed",
            notBefore="2026-07-13T12:00:00Z",
        )
        call_args = agent.session.put.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        self.assertEqual(payload["error"], "CloudflareBlock: challenge failed")
        self.assertEqual(payload["notBefore"], "2026-07-13T12:00:00Z")

    def test_deferred_to_queued_is_legal(self):
        _assert_legal_transition("deferred", "queued")

    def test_deferred_to_completed_is_illegal(self):
        with self.assertRaises(IllegalTransitionError):
            _assert_legal_transition("deferred", "completed")

    def test_shutdown_releases_claimed_to_queued(self):
        """On shutdown, claimed jobs should be released to queued (not deferred)."""
        agent = _make_agent()
        job_id = "job-501"
        agent._last_status[job_id] = "claimed"
        agent.session.put.return_value = _mock_response(200)
        # Simulate the shutdown release
        agent.update_job(job_id, status="queued", error="agent shutting down")
        # Verify the transition was claimed -> queued (legal)
        self.assertEqual(agent._last_status[job_id], "queued")
        event = agent._transition_events[-1]
        self.assertEqual(event["previousStatus"], "claimed")
        self.assertEqual(event["nextStatus"], "queued")


class TestTransitionEventLog(unittest.TestCase):
    """Test the transition event audit log."""

    def test_events_are_append_only(self):
        """Multiple transitions should all be recorded in order."""
        agent = _make_agent()
        job_id = "job-600"
        agent.session.put.return_value = _mock_response(200)
        agent._last_status[job_id] = "claimed"
        agent.update_job(job_id, status="running")
        agent.update_job(job_id, status="completed")
        self.assertEqual(len(agent._transition_events), 2)
        self.assertEqual(agent._transition_events[0]["nextStatus"], "running")
        self.assertEqual(agent._transition_events[1]["nextStatus"], "completed")

    def test_event_includes_all_required_fields(self):
        """Each transition event must have previousStatus, nextStatus, agentId, attempt, timestamp."""
        agent = _make_agent()
        job_id = "job-601"
        agent._last_status[job_id] = "running"
        agent._last_attempt[job_id] = 3
        agent.session.put.return_value = _mock_response(200)
        agent.update_job(job_id, status="failed", error="boom", attempts=3)
        event = agent._transition_events[-1]
        self.assertIn("previousStatus", event)
        self.assertIn("nextStatus", event)
        self.assertIn("agentId", event)
        self.assertIn("attempt", event)
        self.assertIn("timestamp", event)
        self.assertEqual(event["previousStatus"], "running")
        self.assertEqual(event["nextStatus"], "failed")
        self.assertEqual(event["agentId"], "test-worker-1")
        self.assertEqual(event["attempt"], 3)
        self.assertIn("timestamp", event)
        self.assertIn("T", event["timestamp"])  # ISO 8601


if __name__ == "__main__":
    unittest.main(verbosity=2)
