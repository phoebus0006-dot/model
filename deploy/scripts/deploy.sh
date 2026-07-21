#!/usr/bin/env bash
set -euo pipefail

# ModelWiki Safe Deployment Script
# 1. Runs pre-deploy backup
# 2. Builds & launches Docker containers
# 3. Runs smoke test
# 4. Rollbacks automatically on failure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=================================================="
echo " Starting ModelWiki Production Deployment"
echo " Working Directory: $ROOT_DIR"
echo "=================================================="

# Check env file
if [ ! -f "$ROOT_DIR/.env.production" ]; then
    echo "ERROR: .env.production file not found at $ROOT_DIR/.env.production!"
    echo "Please create .env.production with required secrets before deploying."
    exit 1
fi

# Run pre-deploy backup
bash "$SCRIPT_DIR/backup.sh"

echo "[DEPLOY] Pulling/Building containers..."
docker compose -f "$ROOT_DIR/deploy/compose.prod.yml" --env-file "$ROOT_DIR/.env.production" build --no-cache

echo "[DEPLOY] Running database migrations..."
docker compose -f "$ROOT_DIR/deploy/compose.prod.yml" --env-file "$ROOT_DIR/.env.production" up migrate

echo "[DEPLOY] Starting services..."
docker compose -f "$ROOT_DIR/deploy/compose.prod.yml" --env-file "$ROOT_DIR/.env.production" up -d --remove-orphans

echo "[DEPLOY] Waiting for API to settle..."
sleep 5

# Run smoke test
if bash "$SCRIPT_DIR/smoke-test.sh"; then
    echo "[DEPLOY] Deployment succeeded!"
else
    echo "[DEPLOY] Smoke tests failed! Initiating automatic rollback..."
    bash "$SCRIPT_DIR/rollback.sh"
    exit 1
fi
