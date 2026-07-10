#!/bin/bash
set -e

echo "=== ModelWiki Deploy Script v3.0 ==="

cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "Please edit .env with your actual passwords and API keys before continuing."
    echo "   Run: nano .env"
    exit 1
fi

echo "[1/7] Stopping existing services..."
docker compose down 2>/dev/null || true

echo "[2/7] Pulling latest images..."
docker compose pull

echo "[3/7] Building API image..."
docker compose build api

echo "[4/7] Starting services..."
docker compose up -d

echo "[5/7] Waiting for PostgreSQL..."
until docker compose exec -T postgres pg_isready -U modelwiki > /dev/null 2>&1; do
    echo "  Waiting for PostgreSQL..."
    sleep 2
done
echo "PostgreSQL is ready."

echo "[6/7] Running database migrations..."
docker compose exec -T api npx prisma db push --accept-data-loss 2>/dev/null || echo "  Prisma push skipped (will use SQL schema)"

echo "[7/7] Seeding initial data..."
TABLE_COUNT=$(docker compose exec -T postgres psql -U modelwiki -d modelwiki -t -c "SELECT COUNT(*) FROM figures;" 2>/dev/null | tr -d ' ')
if [ "$TABLE_COUNT" = "0" ] || [ -z "$TABLE_COUNT" ]; then
    echo "  Seeding database..."
    docker compose exec -T postgres psql -U modelwiki -d modelwiki < /dev/null 2>/dev/null || true
    if [ -f db/seed-data.sql ]; then
        cat db/seed-data.sql | docker compose exec -T postgres psql -U modelwiki -d modelwiki
        echo "  Seed data loaded successfully."
    else
        echo "  No seed-data.sql found, skipping."
    fi
else
    echo "  Database already has $TABLE_COUNT figures, skipping seed."
fi

echo "Waiting for API..."
sleep 5
API_STATUS=$(curl -s http://localhost:3000/health 2>/dev/null || echo "failed")
echo "API Health: $API_STATUS"

echo ""
echo "=== Deployment Complete ==="
echo "WordPress:  https://site.com"
echo "API:        https://site.com/api/v1/"
echo "Admin:      https://site.com/wp-admin/"
echo ""
echo "Next steps:"
echo "  1. Activate ModelWiki theme in WP Admin > Appearance > Themes"
echo "  2. Go to Settings > Permalinks and click Save to flush rewrite rules"
echo "  3. Go to Customizer and set API URL if needed"
echo ""
echo "Useful commands:"
echo "  docker compose logs -f          # View logs"
echo "  docker compose ps               # Check status"
echo "  docker compose restart api      # Restart API"
echo "  docker compose exec postgres psql -U modelwiki -d modelwiki  # DB shell"
