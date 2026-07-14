#!/usr/bin/env python3
"""Artifact classification tool for the ModelWiki repository.

Scans the git working tree and tracked files for temporary artifacts
(diff.txt, *.patch, *.tar.gz, *.bundle, etc.) and reports their
classification. Exits non-zero if any forbidden artifact is currently
tracked in git.

Usage:
    python scripts/reconciliation/classify_artifacts.py
    python scripts/reconciliation/classify_artifacts.py --strict

Managed by Agent Repository Hygiene (Wave 1, branch agent/repository-hygiene).
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

# Artifact patterns that MUST NOT be tracked.
# These are temporary build/audit artifacts, not source code.
FORBIDDEN_PATTERNS = [
    "diff.txt",
    "*.patch",
    "*.patch.sha256",
    "*.tar.gz",
    "*.tar.gz.sha256",
    "*.bundle",
    "*.bundle.sha256",
    "backend_code.txt",
    "src.tar.gz",
]

# Patterns that are intentionally tracked despite matching broad ignore rules.
# (e.g. Prisma migration .sql files are source code.)
ALLOWED_PREFIXES = (
    "mw-backend/prisma/migrations/",
)


@dataclass
class Finding:
    """A single artifact finding."""

    path: str
    tracked: bool
    classification: str
    reason: str


def _git_ls_files() -> list[str]:
    """Return list of tracked files."""
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []


def _git_untracked() -> list[str]:
    """Return list of untracked files (respecting .gitignore)."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []


def _matches_pattern(path: str, pattern: str) -> bool:
    """Check if a path matches a glob pattern (filename or suffix)."""
    from fnmatch import fnmatch

    name = Path(path).name
    if fnmatch(name, pattern):
        return True
    return fnmatch(path, pattern)


def _is_allowed(path: str) -> bool:
    """Check if a path is explicitly allowed despite matching a pattern."""
    return any(path.startswith(prefix) for prefix in ALLOWED_PREFIXES)


def _classify(path: str) -> tuple[str, str]:
    """Return (classification, reason) for a matching path."""
    name = Path(path).name
    if name.endswith(".bundle") or name.endswith(".bundle.sha256"):
        return "RECOVERY_BUNDLE", "Recovery bundle must not be committed"
    if name.endswith(".tar.gz") or name.endswith(".tar.gz.sha256"):
        return "UNTRUSTED_ARCHIVE", "Binary archive of tracked source"
    if name.endswith(".patch") or name.endswith(".patch.sha256"):
        return "REPORT_ONLY", "Patch file is not a source modification"
    if name == "diff.txt":
        return "REPORT_ONLY", "Diff output, not source code"
    if name in ("backend_code.txt", "src.tar.gz"):
        return "REPORT_ONLY", "Code dump of tracked files"
    return "REPORT_ONLY", "Temporary artifact"


def scan(tracked: Iterable[str], untracked: Iterable[str]) -> list[Finding]:
    """Scan tracked and untracked files for forbidden artifacts."""
    findings: list[Finding] = []

    for path in tracked:
        if _is_allowed(path):
            continue
        for pattern in FORBIDDEN_PATTERNS:
            if _matches_pattern(path, pattern):
                classification, reason = _classify(path)
                findings.append(
                    Finding(
                        path=path,
                        tracked=True,
                        classification=classification,
                        reason=reason,
                    )
                )
                break

    for path in untracked:
        if _is_allowed(path):
            continue
        for pattern in FORBIDDEN_PATTERNS:
            if _matches_pattern(path, pattern):
                classification, reason = _classify(path)
                findings.append(
                    Finding(
                        path=path,
                        tracked=False,
                        classification=classification,
                        reason=reason,
                    )
                )
                break

    return findings


def report(findings: list[Finding]) -> int:
    """Print findings and return exit code."""
    if not findings:
        print("Artifact Classification: PASS")
        print("  No forbidden artifacts found in tracked files or working tree.")
        return 0

    tracked_findings = [f for f in findings if f.tracked]
    untracked_findings = [f for f in findings if not f.tracked]

    print("Artifact Classification: FAIL")
    print(f"  Tracked forbidden artifacts: {len(tracked_findings)}")
    print(f"  Untracked artifacts on disk:  {len(untracked_findings)}")
    print()

    if tracked_findings:
        print("TRACKED (must be removed):")
        for f in tracked_findings:
            print(f"  [{f.classification}] {f.path}")
            print(f"    {f.reason}")
        print()

    if untracked_findings:
        print("UNTRACKED (will be blocked by .gitignore):")
        for f in untracked_findings:
            print(f"  [{f.classification}] {f.path}")
            print(f"    {f.reason}")
        print()

    # Exit non-zero only if forbidden artifacts are TRACKED.
    # Untracked artifacts are just informational (already gitignored).
    return 1 if tracked_findings else 0


def main() -> int:
    strict = "--strict" in sys.argv
    tracked = _git_ls_files()
    untracked = _git_untracked()
    findings = scan(tracked, untracked)
    exit_code = report(findings)

    # In strict mode, any finding (even untracked) is a failure.
    if strict and findings:
        return 1
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
