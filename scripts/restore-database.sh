#!/usr/bin/env bash
# Restores a backup made by scripts/backup-database.sh into an empty database, timed, and optionally compares every
# table's row count with another database. Usage: restore-database.sh <target database url>; see infra/staging/backups.md.
#
# Inputs: BACKUP_ENV and BACKUP_REMOTE as for the backup. Optional BACKUP_NAME (default: the newest backup) and
# COMPARE_DATABASE_URL (the database the backup came from, to check that nothing was lost).
set -euo pipefail

target=${1:?usage: restore-database.sh <target database url>}
: "${BACKUP_ENV:?BACKUP_ENV is required, e.g. staging}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE is required, e.g. :s3:<bucket>}"
PG_IMAGE=${PG_IMAGE:-postgres:18-alpine}

# Exact row count of every table, one "schema.table count" line each, from a single query.
COUNT_ROWS="SELECT table_schema || '.' || table_name || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
  ORDER BY 1"
row_counts() {
  PGURL=${1/-pooler./.} COUNT_ROWS=$COUNT_ROWS docker run --rm --network host -e PGURL -e COUNT_ROWS "$PG_IMAGE" \
    sh -c 'exec psql --no-psqlrc --quiet --tuples-only --no-align --dbname="$PGURL" --command="$COUNT_ROWS"'
}

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
started=$SECONDS

name=${BACKUP_NAME:-$(rclone lsf --include "${BACKUP_ENV}-*.dump" "$BACKUP_REMOTE" | sort | tail -n 1)}
[[ -n $name ]] || { echo "no ${BACKUP_ENV} backup found in $BACKUP_REMOTE" >&2; exit 1; }
rclone copyto "$BACKUP_REMOTE/$name" "$workdir/$name"
downloaded=$((SECONDS - started))

# One transaction: a restore that fails part-way leaves the target empty instead of half-filled.
PGURL=${target/-pooler./.} docker run --rm -i --network host -e PGURL "$PG_IMAGE" \
  sh -c 'exec pg_restore --no-owner --no-acl --single-transaction --exit-on-error --dbname="$PGURL"' <"$workdir/$name"
echo "restored $name in $((SECONDS - started))s (download ${downloaded}s)"
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  echo "Restored \`$name\` into a fresh database in $((SECONDS - started)) s (download ${downloaded} s)." >>"$GITHUB_STEP_SUMMARY"
fi

[[ -n ${COMPARE_DATABASE_URL:-} ]] || exit 0
row_counts "$target" >"$workdir/restored"
row_counts "$COMPARE_DATABASE_URL" >"$workdir/source"
# Two empty lists would "match", so a count that found no tables is a failure, not a pass.
[[ -s $workdir/source && -s $workdir/restored ]] || { echo "could not count the tables' rows" >&2; exit 1; }
if ! diff -u "$workdir/source" "$workdir/restored" >"$workdir/diff"; then
  echo "row counts differ (- source, + restored):" >&2
  grep -E '^[-+][^-+]' "$workdir/diff" >&2
  exit 1
fi
echo "row counts match in all $(wc -l <"$workdir/restored") tables"
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    echo
    echo "Row counts match in all $(wc -l <"$workdir/restored") tables:"
    echo
    echo '```'
    cat "$workdir/restored"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi
