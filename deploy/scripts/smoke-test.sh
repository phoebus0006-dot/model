#!/usr/bin/env bash
set -euo pipefail

# ModelWiki Deployment Smoke Test Script
# Verifies container health, /health, /ready, and proxy endpoints.

TARGET_HOST="${TARGET_HOST:-http://127.0.0.1:3000}"

echo "[SMOKE] Running post-deploy smoke tests against $TARGET_HOST..."

# 1. Healthcheck endpoint
echo -n "[SMOKE] Checking /health... "
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET_HOST/health")
if [ "$HEALTH_CODE" -eq 200 ]; then
    echo "OK (200)"
else
    echo "FAILED ($HEALTH_CODE)"
    exit 1
fi

# 2. Readiness endpoint
echo -n "[SMOKE] Checking /ready... "
READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET_HOST/ready")
if [ "$READY_CODE" -eq 200 ]; then
    echo "OK (200)"
else
    echo "FAILED ($READY_CODE)"
    exit 1
fi

# 3. Public GET route
echo -n "[SMOKE] Checking /api/v1/figures... "
FIG_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET_HOST/api/v1/figures")
if [ "$FIG_CODE" -eq 200 ] || [ "$FIG_CODE" -eq 404 ]; then
    echo "OK ($FIG_CODE)"
else
    echo "FAILED ($FIG_CODE)"
    exit 1
fi

echo "[SMOKE] All smoke tests passed successfully!"
