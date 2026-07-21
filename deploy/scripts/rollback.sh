#!/usr/bin/env bash
set -euo pipefail

# ModelWiki Emergency Rollback Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "[ROLLBACK] Stopping failing production containers..."
docker compose -f "$ROOT_DIR/deploy/compose.prod.yml" --env-file "$ROOT_DIR/.env.production" down --remove-orphans || true

echo "[ROLLBACK] Re-starting previous stable container image if cached..."
docker compose -f "$ROOT_DIR/deploy/compose.prod.yml" --env-file "$ROOT_DIR/.env.production" up -d api postgres redis

echo "[ROLLBACK] Rollback procedure executed."
