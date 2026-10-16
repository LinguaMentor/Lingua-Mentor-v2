#!/usr/bin/env bash
# Dumps one environment's database to its private R2 bucket and prunes dumps older than 30 days. Run nightly by
# .github/workflows/backup-database.yml; the restore side is scripts/restore-database.sh and infra/staging/backups.md.
#
# Inputs: DATABASE_URL, BACKUP_ENV (staging), BACKUP_REMOTE (":s3:<bucket>" with the RCLONE_S3_* settings, or a local
# directory in tests). Optional PUSH_URL, PUSH_USER, PUSH_TOKEN: the Grafana heartbeat whose absence alerts the team.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_ENV:?BACKUP_ENV is required, e.g. staging}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE is required, e.g. :s3:<bucket>}"
[[ $BACKUP_ENV =~ ^[a-z]+$ ]] || { echo "BACKUP_ENV must be one lowercase word" >&2; exit 2; }

# Matches the server's major version: Neon advises a client that matches the project's Postgres.
PG_IMAGE=${PG_IMAGE:-postgres:18-alpine}
RETENTION_DAYS=30

# Neon's pooler can't serve pg_dump; the direct host is the same name without "-pooler".
direct_url=${DATABASE_URL/-pooler./.}

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
name="${BACKUP_ENV}-$(date -u +%Y%m%dT%H%M%SZ).dump"
started=$SECONDS

# The URL travels in the environment, never on a command line another process could read.
PGURL=$direct_url docker run --rm --network host -e PGURL "$PG_IMAGE" \
  sh -c 'exec pg_dump --format=custom --no-owner --no-acl --dbname="$PGURL"' >"$workdir/$name"

# A truncated or corrupt archive fails here, before it can replace a good backup.
tables=$(docker run --rm -i "$PG_IMAGE" pg_restore --list <"$workdir/$name" | grep -c ' TABLE DATA ' || true)
[[ $tables -gt 0 ]] || { echo "the dump contains no table data" >&2; exit 1; }

rclone copyto "$workdir/$name" "$BACKUP_REMOTE/$name"
# Only after a good upload, so a broken job never prunes the last backups away.
rclone delete --min-age "${RETENTION_DAYS}d" --include "${BACKUP_ENV}-*.dump" "$BACKUP_REMOTE"

size=$(du -h "$workdir/$name" | cut -f1)
echo "uploaded $name ($size, $tables tables) in $((SECONDS - started))s"
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  echo "Backup \`$name\`: $size, $tables tables, $((SECONDS - started)) s." >>"$GITHUB_STEP_SUMMARY"
fi

if [[ -n ${PUSH_URL:-} ]]; then
  curl -fsS -m 10 --retry 3 -o /dev/null -H "Authorization: Bearer ${PUSH_USER}:${PUSH_TOKEN}" \
    --data-binary "backup,target=database,environment=${BACKUP_ENV} success=1" "$PUSH_URL" \
    || echo "could not push the backup heartbeat" >&2
fi
