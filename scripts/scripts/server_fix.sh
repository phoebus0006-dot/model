#!/bin/bash
set -e

echo "=== ModelWiki Fix Deploy ==="

DOCKER_DIR="/root/modelwiki/docker"
THEME_SRC="$DOCKER_DIR/wordpress/wp-content/themes/modelwiki"
VOLUME_PATH="/var/lib/docker/volumes/docker_wp_data/_data/wp-content/themes/modelwiki"
NGINX_CONF="$DOCKER_DIR/nginx/otaku.conf"
BAOTA_NGINX="/www/server/panel/vhost/nginx/otaku.phoebusatelier.com.conf"

echo "[1/5] Copying fixed theme files to bind-mount source..."
if [ -d "$THEME_SRC" ]; then
    echo "  Theme source directory exists at $THEME_SRC"
    echo "  Files will be read from bind mount (already updated via SCP)"
else
    echo "  Creating theme directory..."
    mkdir -p "$THEME_SRC/template-parts"
fi

echo "[2/5] Restarting WordPress container to pick up changes..."
cd "$DOCKER_DIR" 2>/dev/null || cd /root/modelwiki/docker 2>/dev/null || echo "  WARNING: Could not find docker dir"
docker compose restart wordpress 2>/dev/null && echo "  WordPress restarted" || echo "  WARNING: WordPress restart failed"

echo "[3/5] Syncing theme to Docker volume host path..."
if [ -d "$THEME_SRC" ] && [ -d "/var/lib/docker/volumes/docker_wp_data/_data" ]; then
    mkdir -p "$VOLUME_PATH/template-parts"
    cp -r "$THEME_SRC"/* "$VOLUME_PATH/" 2>/dev/null || true
    echo "  Synced to $VOLUME_PATH"
fi

echo "[4/5] Updating nginx config..."
if [ -f "$NGINX_CONF" ]; then
    if [ -d "/www/server/panel/vhost/nginx" ]; then
        cp "$NGINX_CONF" "$BAOTA_NGINX"
        echo "  Updated Baota nginx config at $BAOTA_NGINX"
    fi
    if [ -d "/etc/nginx/conf.d" ]; then
        cp "$NGINX_CONF" /etc/nginx/conf.d/otaku.conf
        echo "  Updated /etc/nginx/conf.d/otaku.conf"
    fi
fi

nginx -t && nginx -s reload && echo "  nginx reloaded" || echo "  WARNING: nginx reload failed"

echo "[5/5] Clearing Redis cache..."
# Auth via REDISCLI_AUTH env var (export before running this script if required)
docker exec mw-redis redis-cli --no-auth-warning FLUSHALL 2>/dev/null && echo "  Redis cache cleared" || \
    (echo "  Trying without password..." && docker exec mw-redis redis-cli FLUSHALL 2>/dev/null && echo "  Redis cache cleared (no auth)") || \
    echo "  WARNING: Could not clear Redis"

sleep 3

echo ""
echo "=== Verification ==="
echo -n "API: "; curl -s http://127.0.0.1:3001/health || echo "FAILED"
echo -n "Admin page HTTP status: "; curl -s -o /dev/null -w "%{http_code}" -H "Host: otaku.phoebusatelier.com" http://127.0.0.1/admin/ || echo "FAILED"
echo ""
echo "Done. Verify: https://otaku.phoebusatelier.com/admin/"