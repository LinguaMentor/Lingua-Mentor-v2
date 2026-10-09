#!/usr/bin/env bash
# Online copy of the Bugsink database, compressed and uploaded to R2. Installed as bugsink-backup, run by its timer.
set -euo pipefail

DATABASE=/home/bugsink/db.sqlite3
RETENTION_DAYS=30

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# sqlite3 .backup is safe while Bugsink writes; a plain file copy is not.
sqlite3 "$DATABASE" ".backup '$workdir/db.sqlite3'"
[[ $(sqlite3 "$workdir/db.sqlite3" 'PRAGMA integrity_check') == ok ]] || { echo "backup failed the integrity check" >&2; exit 1; }

name="bugsink-$(date -u +%Y%m%dT%H%M%SZ).sqlite3.gz"
gzip -9 "$workdir/db.sqlite3"
rclone copyto "$workdir/db.sqlite3.gz" "$BACKUP_REMOTE/$name"
rclone delete --min-age "${RETENTION_DAYS}d" --include 'bugsink-*.sqlite3.gz' "$BACKUP_REMOTE"
echo "uploaded $name"
