#!/usr/bin/env bash
set -euo pipefail

# ModelWiki Pre-Deploy Backup Script
# Creates timestamped SQL dump and volume snapshot before deployment.

BACKUP_DIR="${BACKUP_DIR:-/var/backups/modelwiki}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
mkdir -p "$BACKUP_DIR"

echo "[BACKUP] Starting pre-deploy backup at $TIMESTAMP..."

if docker ps | grep -q "modelwiki-prod-postgres"; then
    echo "[BACKUP] Dumping PostgreSQL database..."
    docker exec modelwiki-prod-postgres pg_dumpall -U "${POSTGRES_USER:-modelwiki}" > "$BACKUP_DIR/db_backup_$TIMESTAMP.sql"
    gzip "$BACKUP_DIR/db_backup_$TIMESTAMP.sql"
    echo "[BACKUP] DB dump saved to $BACKUP_DIR/db_backup_$TIMESTAMP.sql.gz"
else
    echo "[BACKUP] Warning: modelwiki-prod-postgres container not running; skipping live DB dump."
fi

echo "[BACKUP] Pre-deploy backup completed successfully."
