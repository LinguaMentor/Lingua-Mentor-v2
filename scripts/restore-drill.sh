#!/usr/bin/env bash
# Restore drill: restores the newest backup into a new, empty database next to the real one, checks every table's row
# count against the real one, prints the time, and drops the new database whatever happens. Inputs as for the restore.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_IMAGE=${PG_IMAGE:-postgres:18-alpine}
source_url=${DATABASE_URL/-pooler./.}
drill_db="restore_drill_${GITHUB_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"

# The same server and credentials, another database name; any query string (sslmode, ...) is kept.
with_database() {
  local url=$1 query=""
  [[ $url == *\?* ]] && query="?${url#*\?}"
  url=${url%%\?*}
  printf '%s/%s%s' "${url%/*}" "$2" "$query"
}
sql() {
  PGURL=$source_url SQL=$1 docker run --rm --network host -e PGURL -e SQL "$PG_IMAGE" \
    sh -c 'exec psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --dbname="$PGURL" --command="$SQL"'
}

sql "CREATE DATABASE $drill_db"
trap 'sql "DROP DATABASE IF EXISTS $drill_db WITH (FORCE)" && echo "dropped $drill_db"' EXIT
COMPARE_DATABASE_URL=$source_url bash "$ROOT/scripts/restore-database.sh" "$(with_database "$source_url" "$drill_db")"
