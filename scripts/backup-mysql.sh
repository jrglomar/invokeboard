#!/usr/bin/env bash
# Dump the InvokeBoard MySQL database to a gzip'd SQL file (v1.74, ADR-085).
#
#   scripts/backup-mysql.sh [backup-dir]        # default: /backups/invokeboard
#
# Run from the repo root on the server. Consistent online dump (InnoDB, --single-transaction),
# keeps the newest $KEEP dumps (default 14). Nightly cron example:
#   0 2 * * * cd /opt/invokeboard && scripts/backup-mysql.sh >> /var/log/invokeboard-backup.log 2>&1
#
# The dump holds sealed tokens: keep backups AWAY from .env (TOKEN_ENC_KEY) — DEPLOYMENT.md §5.5.
set -euo pipefail

BACKUP_DIR="${1:-/backups/invokeboard}"
KEEP="${KEEP:-14}"
COMPOSE=(docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}")
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/invokeboard-mysql-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
umask 077

# Credentials are read INSIDE the container from its own env — never echoed on the host command line.
"${COMPOSE[@]}" exec -T mysql sh -c \
  'exec mysqldump --single-transaction --quick --routines --no-tablespaces \
     -uroot -p"$MYSQL_ROOT_PASSWORD" --databases "$MYSQL_DATABASE"' \
  | gzip -9 > "$OUT.partial"
mv "$OUT.partial" "$OUT"

# Sanity: a dump without the docs table is not a backup.
if ! gzip -dc "$OUT" | grep -q 'CREATE TABLE `docs`'; then
  echo "[backup-mysql] ERROR: $OUT has no docs table — check the mysql service" >&2
  exit 1
fi

ls -1t "$BACKUP_DIR"/invokeboard-mysql-*.sql.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "[backup-mysql] wrote $OUT ($(du -h "$OUT" | cut -f1)); keeping newest $KEEP"
