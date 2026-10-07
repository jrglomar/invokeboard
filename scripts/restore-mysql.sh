#!/usr/bin/env bash
# Restore an InvokeBoard MySQL dump made by scripts/backup-mysql.sh (v1.74, ADR-085).
#
#   scripts/restore-mysql.sh <invokeboard-mysql-*.sql.gz> [--yes]
#
# REPLACES the current database contents. The jira bridge is stopped first (its write-behind cache
# would otherwise overwrite restored rows) and started again afterwards so it re-reads everything.
set -euo pipefail

DUMP="${1:?usage: restore-mysql.sh <dump.sql.gz> [--yes]}"
COMPOSE=(docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}")
[[ -f "$DUMP" ]] || { echo "no such file: $DUMP" >&2; exit 1; }

if [[ "${2:-}" != "--yes" ]]; then
  read -r -p "This REPLACES the live InvokeBoard database with $DUMP. Type 'restore' to continue: " ok
  [[ "$ok" == "restore" ]] || { echo "aborted"; exit 1; }
fi

"${COMPOSE[@]}" stop jira
gzip -dc "$DUMP" | "${COMPOSE[@]}" exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'
"${COMPOSE[@]}" start jira
echo "[restore-mysql] restored $DUMP; jira restarted (check: ${COMPOSE[*]} logs jira | grep 'loaded')"
