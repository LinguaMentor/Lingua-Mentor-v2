#!/usr/bin/env bash
# Replaces the Bugsink database with a backup from R2. Installed as bugsink-restore.
# Usage: sudo bugsink-restore [latest|<backup file name>]
set -euo pipefail

DATABASE=/home/bugsink/db.sqlite3

[[ $EUID -eq 0 ]] || { echo "error: run as root (sudo)" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. /etc/bugsink/backup.env
set +a

name=${1:-latest}
if [[ $name == latest ]]; then
  name=$(rclone lsf --files-only --include 'bugsink-*.sqlite3.gz' "$BACKUP_REMOTE" | sort | tail -n 1)
  [[ -n $name ]] || { echo "error: no backups found in $BACKUP_REMOTE" >&2; exit 1; }
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
echo "==> downloading $name"
rclone copyto "$BACKUP_REMOTE/$name" "$workdir/db.sqlite3.gz"
gunzip "$workdir/db.sqlite3.gz"
[[ $(sqlite3 "$workdir/db.sqlite3" 'PRAGMA integrity_check') == ok ]] || { echo "error: the backup failed the integrity check" >&2; exit 1; }

echo "==> replacing the database"
systemctl stop bugsink-gunicorn bugsink-snappea
[[ -f $DATABASE ]] && mv "$DATABASE" "$DATABASE.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
# A leftover journal from the old file would be applied to the restored one.
rm -f "$DATABASE-wal" "$DATABASE-shm" "$DATABASE-journal"
install -m 0600 -o bugsink -g bugsink "$workdir/db.sqlite3" "$DATABASE"

# The backup may come from an older Bugsink version.
bugsink-manage migrate --verbosity 0
systemctl start bugsink-snappea bugsink-gunicorn
echo "==> restored $name"
