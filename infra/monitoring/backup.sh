#!/usr/bin/env bash
# Online copy of the Bugsink database, compressed and uploaded to R2. Installed as bugsink-backup, run by its timer.
set -euo pipefail

DATABASE=/home/bugsink/db.sqlite3
RETENTION_DAYS=30

# Optional. The heartbeat check alerts the team when a night passes without a success ping, and at once on /fail.
heartbeat() {
  [[ -n ${HEARTBEAT_URL:-} ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEARTBEAT_URL}$1" || echo "the heartbeat ping failed" >&2
}

workdir=$(mktemp -d)
trap 'status=$?; rm -rf "$workdir"; ((status == 0)) || heartbeat /fail' EXIT

# sqlite3 .backup is safe while Bugsink writes; a plain file copy is not.
sqlite3 "$DATABASE" ".backup '$workdir/db.sqlite3'"
[[ $(sqlite3 "$workdir/db.sqlite3" 'PRAGMA integrity_check') == ok ]] || { echo "backup failed the integrity check" >&2; exit 1; }

name="bugsink-$(date -u +%Y%m%dT%H%M%SZ).sqlite3.gz"
gzip -9 "$workdir/db.sqlite3"
rclone copyto "$workdir/db.sqlite3.gz" "$BACKUP_REMOTE/$name"
rclone delete --min-age "${RETENTION_DAYS}d" --include 'bugsink-*.sqlite3.gz' "$BACKUP_REMOTE"
echo "uploaded $name"
heartbeat ""
