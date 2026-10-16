#!/usr/bin/env bash
# Runs infra/monitoring/backup.sh with sqlite3 and rclone stubbed, and a local listener standing in for Grafana Cloud.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
PORT=$((20000 + RANDOM % 20000))
trap 'kill "$listener" 2>/dev/null || true; rm -rf "$WORK"' EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
flunk() {
	printf 'FAIL %s\n' "$1" >&2
	failures=$((failures + 1))
}

mkdir "$WORK/bin"
cat >"$WORK/bin/sqlite3" <<'EOF'
#!/usr/bin/env bash
case $2 in
  .backup*) dest=${2#.backup \'}; printf 'data' >"${dest%\'}" ;;
  PRAGMA*) echo "${INTEGRITY:-ok}" ;;
esac
EOF
cat >"$WORK/bin/rclone" <<'EOF'
#!/usr/bin/env bash
[[ $1 == copyto && -n ${RCLONE_FAIL:-} ]] && { echo "upload failed" >&2; exit 1; }
exit 0
EOF
chmod +x "$WORK/bin/sqlite3" "$WORK/bin/rclone"

# Records each push as "<path> | <authorization> | <body>", one line per request.
python3 - "$PORT" "$WORK/pushes" <<'EOF' &
import http.server, sys
port, out = int(sys.argv[1]), sys.argv[2]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        with open(out, "a") as f:
            f.write(f"{self.path} | {self.headers.get('authorization', '')} | {body}\n")
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
EOF
listener=$!
for _ in $(seq 50); do (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 0.1; done

PUSH="PUSH_URL=http://127.0.0.1:$PORT/api/v1/push/influx/write PUSH_USER=123456 PUSH_TOKEN=test-token"
touch "$WORK/pushes"

# Runs the backup with extra environment assignments; prints its exit code and how many pushes it added.
run() {
	local before after status=0
	before=$(wc -l <"$WORK/pushes")
	env PATH="$WORK/bin:$PATH" BACKUP_REMOTE=":s3:bucket/bugsink" "$@" bash "$ROOT/infra/monitoring/backup.sh" >/dev/null 2>&1 || status=$?
	after=$(wc -l <"$WORK/pushes")
	echo "$status $((after - before))"
}

expect() { # description, expected, actual
	if [[ $3 == "$2" ]]; then pass "$1"; else flunk "$1 (expected '$2', got '$3')"; fi
}

# shellcheck disable=SC2086  # PUSH is a list of assignments for env
expect "a good run exits 0 and pushes once" "0 1" "$(run $PUSH)"
expect "the push is the backup_success point, with the instance ID and token as a bearer" \
	"/api/v1/push/influx/write | Bearer 123456:test-token | backup,target=bugsink success=1" "$(tail -n 1 "$WORK/pushes")"
# shellcheck disable=SC2086
expect "a failed upload exits 1 and pushes nothing" "1 0" "$(run $PUSH RCLONE_FAIL=1)"
# shellcheck disable=SC2086
expect "a failed integrity check exits 1 and pushes nothing" "1 0" "$(run $PUSH INTEGRITY=corrupt)"
expect "without push settings a good run still exits 0" "0 0" "$(run)"
expect "an unreachable Grafana never fails the backup" "0 0" \
	"$(run PUSH_URL=http://127.0.0.1:1/api/v1/push/influx/write PUSH_USER=1 PUSH_TOKEN=t)"

if ((failures > 0)); then
	printf '%d check(s) failed\n' "$failures" >&2
	exit 1
fi
echo "All monitoring backup checks passed."
