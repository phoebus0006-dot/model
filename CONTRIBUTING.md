# Contributing to ModelWiki

> This document defines the contribution rules for the ModelWiki repository.
> Authored by Agent Repository Hygiene (Wave 1, branch `agent/repository-hygiene`).

## 1. Repository Structure

- `mw-backend/` - Node.js/TypeScript backend (Prisma + Fastify).
- `modelwiki-theme/` - WordPress PHP theme (frontend + admin UI).
- `scripts/` - Operational and deployment tooling.
- `docs/` - Design documents, agent contracts, and reconciliation reports.
- `docs/reconciliation/` - Source-of-truth reports for the Wave 0 reconciliation.
- `scripts/reconciliation/` - Hygiene tooling (artifact classification, verification).

## 2. Branching Model

The repository follows a Wave-based agent branching model:

- `main` - Production integration branch. All agent work merges here.
- `agent/<name>` - Per-agent feature branches, branched from a frozen Wave tag.
- `recovery/*` - Immutable backup branches (DO NOT delete without human approval).
- `backup/*` - Annotated tags marking recovery points.
- `refs/tags/wave0-final` - Frozen canonical reference for Wave 1 start.

**Never force-push to `main` or any `recovery/*` branch.**

## 3. What MUST NOT Be Committed

The following are temporary artifacts and MUST NOT be tracked in git
(they are listed in `.gitignore` and will be rejected by review):

| Pattern | Reason |
|---------|--------|
| `diff.txt` | Diff output, not source code |
| `*.patch`, `*.patch.sha256` | Patch files are not source modifications |
| `*.tar.gz`, `*.tar.gz.sha256` | Binary archives of existing source |
| `backend_code.txt`, `src.tar.gz` | Code dumps of already-tracked files |
| `*.bundle`, `*.bundle.sha256` | Recovery bundles stay off-remote |
| `model-wiki-backups/` | Local immutable backup directory |
| `HERMES_*.md`, `*_REPORT.md` (operational) | Ephemeral operational reports |
| `*.env`, `.env.*`, `*.key`, `*.pem` | Secrets and credentials |
| `m4_*`, `m5_*`, `m6_*`, `m6fix_*` (sql/sh/py/json) | One-off migration scripts |

## 4. Recovery Bundle Policy

- The immutable git bundle lives **outside** the repository
  (`d:\model-wiki-backups\<date>\model-wiki-all-*.bundle`).
- **Never commit the recovery bundle to GitHub.** It is gitignored (`*.bundle`).
- The bundle is verified via `git bundle verify` and its SHA-256 is recorded in
  `docs/reconciliation/REPOSITORY_INVENTORY.md`.

## 5. Recovery Branch Policy

- `recovery/*` branches and `backup/*` tags are **immutable backups**.
- Do NOT delete remote recovery branches unless a human explicitly approves.
- Do NOT merge recovery branches wholesale; salvage via manual port only.
- See `docs/reconciliation/BRANCH_CLASSIFICATION.md` for the full classification.

## 6. Code Hygiene Rules

1. **Patches and archives are not source code.** If a change is needed, edit the
   source file directly. Do not drop a `.patch` or `.tar.gz` and ask reviewers to
   apply it.
2. **Prisma migrations are source code** and MUST be tracked
   (`mw-backend/prisma/migrations/**/*.sql`). The broad `*.sql` ignore rule has a
   negation for migration files.
3. **Formal design documents, migrations, and tests must never be deleted** as part
   of artifact cleanup.
4. **Temporary reports belong in `.gitignore`**, not in the tree.
5. **Commit cleanup as separate commits** (e.g. `chore(repo): remove temporary
   review artifacts`) so reviewers can isolate hygiene changes from features.

## 7. Reconciliation References

- `docs/implementation/WAVE1_AGENT_CONTRACTS.md` - Agent contracts (frozen).
- `docs/reconciliation/POST_PUSH_FINAL_VERIFICATION.md` - Final Wave 0 verification.
- `docs/reconciliation/REPOSITORY_INVENTORY.md` - Source-of-truth inventory.
- `docs/reconciliation/BRANCH_CLASSIFICATION.md` - Branch classification.
- `docs/reconciliation/RECOVERY_PLAN.md` - Recovery plan.
- `docs/reconciliation/ARTIFACT_CLASSIFICATION.md` - Artifact classification report.

## 8. Running the Hygiene Tool

```bash
python scripts/reconciliation/classify_artifacts.py
```

Scans the working tree and git-tracked files for forbidden temporary artifacts
and reports their classification. Exits non-zero if any forbidden artifact is
currently tracked.