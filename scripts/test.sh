#!/bin/bash
set -e

PASS=0
FAIL=0

check() {
    local name="$1"
    local cmd="$2"
    local expected="$3"
    local actual
    actual=$(eval "$cmd" 2>/dev/null)
    if echo "$actual" | grep -q "$expected"; then
        echo "✅ PASS: $name"
        ((PASS++))
    else
        echo "❌ FAIL: $name (expected: $expected, got: ${actual:0:80})"
        ((FAIL++))
    fi
}

cd "$(dirname "$0")"

echo "=== L1: Infrastructure ==="
check "PostgreSQL ready" "docker compose exec -T postgres pg_isready -U modelwiki" "accepting connections"
check "MySQL alive" "docker compose exec -T mysql mysqladmin ping -h localhost -u root -p\${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD is required} 2>/dev/null" "alive"
check "Redis PONG" "docker compose exec -T redis redis-cli ping" "PONG"
check "PG tables" "docker compose exec -T postgres psql -U modelwiki -c '\\dt' -t" "figures"
check "PG seed data" "docker compose exec -T postgres psql -U modelwiki -t -c 'SELECT count(*) FROM manufacturers;'" "5"

echo ""
echo "=== L2: Service Health ==="
check "API health" "curl -s http://localhost:3000/health" "ok"
check "Nginx HTTP" "curl -s -o /dev/null -w '%{http_code}' http://localhost" "301"

echo ""
echo "=== L4: API Functionality ==="
check "Figures list" "curl -s http://localhost:3000/api/v1/figures" "data"
check "Categories list" "curl -s http://localhost:3000/api/v1/categories" "data"
check "Search endpoint" "curl -s 'http://localhost:3000/api/v1/search?q=test'" "data"

echo ""
echo "=== L4: Insert test data ==="
docker compose exec -T postgres psql -U modelwiki -c "
INSERT INTO series (slug, name, name_jp, media_type) VALUES ('vocaloid', 'Vocaloid', 'ボーカロイド', 'software') ON CONFLICT DO NOTHING;
INSERT INTO figures (slug, name, name_jp, scale, price_jpy, release_date, series_id, manufacturer_id)
VALUES ('hatsune-miku-1-7-gsc-2024', '初音未来 1/7 比例', '初音ミク 1/7スケール', '1/7', 15800, '2024-06-30', 1, 1) ON CONFLICT DO NOTHING;
INSERT INTO revisions (figure_id, content_md, summary_md, version_number, is_active, quality_score)
VALUES (1, '# 初音未来 1/7 比例手办\n\n由 Good Smile Company 生产。', 'GSC 初音未来 1/7', 1, true, 8.5) ON CONFLICT DO NOTHING;
UPDATE figures SET active_revision_id = 1 WHERE id = 1;
" 2>/dev/null || true

sleep 1

check "Figure detail" "curl -s http://localhost:3000/api/v1/figures/hatsune-miku-1-7-gsc-2024" "初音"
check "Figure lineage" "curl -s http://localhost:3000/api/v1/figures/hatsune-miku-1-7-gsc-2024/lineage" "current"
check "Figure revisions" "curl -s http://localhost:3000/api/v1/figures/hatsune-miku-1-7-gsc-2024/revisions" "version_number"
check "Search miku" "curl -s 'http://localhost:3000/api/v1/search?q=初音'" "figures"

echo ""
echo "=== L6: Performance ==="
check "API response < 1s" "curl -s -o /dev/null -w '%{time_total}' http://localhost:3000/api/v1/figures" "0\."
check "Redis has data" "docker compose exec -T redis redis-cli DBSIZE" "[1-9]"

echo ""
echo "=== Container Resources ==="
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null || true

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

if [ $FAIL -gt 0 ]; then
    exit 1
fi
