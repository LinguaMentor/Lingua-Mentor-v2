#!/usr/bin/env bash
# Runs scripts/backup-database.sh and scripts/restore-database.sh against a throwaway Postgres 18, a local folder
# standing in for R2 and a listener standing in for Grafana. Needs Docker and rclone.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
PG=dbbackup-test-$$
PG_PORT=$((20000 + RANDOM % 20000))
PUSH_PORT=$((PG_PORT + 1))
cleanup() {
	docker rm -f "$PG" >/dev/null 2>&1 || true
	kill "${listener:-}" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
flunk() {
	printf 'FAIL %s\n' "$1" >&2
	failures=$((failures + 1))
}
expect() { # description, expected, actual
	if [[ $3 == "$2" ]]; then pass "$1"; else flunk "$1 (expected '$2', got '$3')"; fi
}

docker run -d --name "$PG" -e POSTGRES_PASSWORD=test -p "127.0.0.1:$PG_PORT:5432" postgres:18-alpine >/dev/null
for _ in $(seq 60); do docker exec "$PG" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
sql() { docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -At -d "$1"; }
url() { echo "postgresql://postgres:test@127.0.0.1:$PG_PORT/$1?sslmode=disable"; }

sql postgres <<<"CREATE DATABASE app"
sql app <<'EOF'
CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);
CREATE TABLE writing_sessions (id serial PRIMARY KEY, user_id int REFERENCES users (id), essay_text text);
CREATE TABLE alembic_version (version_num text PRIMARY KEY);
INSERT INTO users (email) VALUES ('a@example.test'), ('b@example.test'), ('c@example.test');
INSERT INTO writing_sessions (user_id, essay_text) VALUES (1, 'first essay'), (2, 'second essay');
INSERT INTO alembic_version VALUES ('0001');
EOF

python3 - "$PUSH_PORT" "$WORK/pushes" <<'EOF' &
import http.server, sys
port, out = int(sys.argv[1]), sys.argv[2]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        with open(out, "a") as f:
            f.write(f"{self.headers.get('authorization', '')} | {body}\n")
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
EOF
listener=$!
touch "$WORK/pushes"

REMOTE=$WORK/remote
mkdir -p "$REMOTE"
# A dump past retention, one inside it, and another environment's dump, which retention must never touch.
touch -d '40 days ago' "$REMOTE/test-20240101T000000Z.dump" "$REMOTE/other-20240101T000000Z.dump"
touch -d '10 days ago' "$REMOTE/test-20240301T000000Z.dump"

export BACKUP_ENV=test BACKUP_REMOTE=$REMOTE
backup() { env DATABASE_URL="$1" PUSH_URL="http://127.0.0.1:$PUSH_PORT/api/v1/push/influx/write" PUSH_USER=42 PUSH_TOKEN=t \
	bash "$ROOT/scripts/backup-database.sh" >"$WORK/out" 2>&1; }
dumps() { find "$REMOTE" -name 'test-*.dump' -newermt '-1 hour' | wc -l; }

# ---- backup ------------------------------------------------------------------------------------------------
status=0; backup "$(url app)" || status=$?
expect "a backup of a healthy database exits 0" 0 "$status"
expect "it uploads one new dump" 1 "$(dumps)"
expect "it prunes this environment's dumps older than 30 days" no "$([[ -e $REMOTE/test-20240101T000000Z.dump ]] && echo yes || echo no)"
expect "it keeps dumps inside the 30 days" yes "$([[ -e $REMOTE/test-20240301T000000Z.dump ]] && echo yes || echo no)"
expect "it never prunes another environment's dumps" yes "$([[ -e $REMOTE/other-20240101T000000Z.dump ]] && echo yes || echo no)"
expect "it pushes one success point to Grafana, with the instance ID and token as a bearer" \
	"Bearer 42:t | backup,target=database,environment=test success=1" "$(cat "$WORK/pushes")"

touch -d '40 days ago' "$REMOTE/test-20240102T000000Z.dump"
status=0; backup "postgresql://postgres:test@127.0.0.1:1/app?sslmode=disable" || status=$?
expect "a backup of an unreachable database fails" 1 "$([[ $status -ne 0 ]] && echo 1 || echo 0)"
expect "a failed backup uploads nothing" 1 "$(dumps)"
expect "a failed backup prunes nothing" yes "$([[ -e $REMOTE/test-20240102T000000Z.dump ]] && echo yes || echo no)"
expect "a failed backup pushes nothing" 1 "$(wc -l <"$WORK/pushes")"

# ---- restore -----------------------------------------------------------------------------------------------
restore() { env COMPARE_DATABASE_URL="${2:-}" bash "$ROOT/scripts/restore-database.sh" "$1" >"$WORK/out" 2>&1; }
sql postgres <<<"CREATE DATABASE fresh1"
status=0; restore "$(url fresh1)" "$(url app)" || status=$?
expect "the newest backup restores into a fresh database" 0 "$status"
expect "and every table's row count matches the source" yes "$(grep -q 'row counts match in all 3 tables' "$WORK/out" && echo yes || echo no)"
expect "the restored data is the data" "a@example.test,b@example.test,c@example.test" "$(sql fresh1 <<<"SELECT string_agg(email, ',' ORDER BY id) FROM users")"

status=0; restore "$(url fresh1)" || status=$?
expect "a restore into a database that is not empty fails" 1 "$([[ $status -ne 0 ]] && echo 1 || echo 0)"
expect "and leaves it as it was" 3 "$(sql fresh1 <<<"SELECT count(*) FROM users")"

sql app <<<"INSERT INTO users (email) VALUES ('d@example.test')"
sql postgres <<<"CREATE DATABASE fresh2"
status=0; restore "$(url fresh2)" "$(url app)" || status=$?
expect "a restore whose row counts differ from the source fails" 1 "$([[ $status -ne 0 ]] && echo 1 || echo 0)"
expect "and names the table that differs" yes "$(grep -q 'public.users' "$WORK/out" && echo yes || echo no)"

status=0; env BACKUP_ENV=missing bash "$ROOT/scripts/restore-database.sh" "$(url fresh2)" >"$WORK/out" 2>&1 || status=$?
expect "a restore with no backup to restore fails and says so" yes \
	"$([[ $status -ne 0 ]] && grep -q 'no missing backup found' "$WORK/out" && echo yes || echo no)"

# ---- restore drill ------------------------------------------------------------------------------------------
backup "$(url app)" || flunk "a fresh backup for the drill"
status=0; env DATABASE_URL="$(url app)" GITHUB_RUN_ID=777 bash "$ROOT/scripts/restore-drill.sh" >"$WORK/out" 2>&1 || status=$?
expect "the drill restores the newest backup next to the source and the row counts match" 0 "$status"
expect "it reports the time and the tables it checked" yes \
	"$(grep -q 'restored test-.*in [0-9]*s' "$WORK/out" && grep -q 'row counts match in all 3 tables' "$WORK/out" && echo yes || echo no)"
expect "it drops its database afterwards" 0 "$(sql postgres <<<"SELECT count(*) FROM pg_database WHERE datname = 'restore_drill_777'")"
sql postgres <<<"CREATE DATABASE restore_drill_778; ALTER DATABASE restore_drill_778 OWNER TO postgres"
sql restore_drill_778 <<<"CREATE TABLE users (id int)"
status=0; env DATABASE_URL="$(url app)" GITHUB_RUN_ID=778 bash "$ROOT/scripts/restore-drill.sh" >"$WORK/out" 2>&1 || status=$?
expect "a drill that cannot create its database fails without touching an existing one" 1 \
	"$([[ $status -ne 0 ]] && echo 1 || echo 0)"
expect "and the existing database is still there" 1 "$(sql postgres <<<"SELECT count(*) FROM pg_database WHERE datname = 'restore_drill_778'")"

if ((failures > 0)); then
	printf '%d check(s) failed\n' "$failures" >&2
	exit 1
fi
echo "All database backup checks passed."
