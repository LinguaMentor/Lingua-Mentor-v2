#!/usr/bin/env bash
# Runs infra/staging/deploy.sh for real against a copy of the staging Compose file, with stand-in
# images in a throwaway local registry (so the images are pinned by real digests, as in staging).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
export DEPLOY_DIR=$WORK/staging
export CONF_DIR=$WORK/conf
export COMPOSE_PROJECT_NAME=deploytest$$
export WAIT_TIMEOUT=25
REGISTRY_NAME=deploytest-registry-$$
DEPLOY=$ROOT/infra/staging/deploy.sh

cleanup() {
	# By label: `docker compose down` would need every image variable set.
	docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | xargs -r docker rm -f >/dev/null 2>&1 || true
	docker network rm "${COMPOSE_PROJECT_NAME}_default" >/dev/null 2>&1 || true
	docker volume rm "${COMPOSE_PROJECT_NAME}_redis-data" >/dev/null 2>&1 || true
	docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
	chmod -R u+w "$WORK" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
flunk() {
	printf 'FAIL %s\n' "$1" >&2
	failures=$((failures + 1))
}
check() { # description, then a command that must succeed; its output is shown only when it fails
	local description=$1
	shift
	if "$@" >"$WORK/check.out" 2>&1; then
		pass "$description"
	else
		flunk "$description"
		tail -n 15 "$WORK/check.out" | sed 's/^/     | /' >&2
	fi
}

# ---- stand-in images -------------------------------------------------------------------------------------
docker run -d --name "$REGISTRY_NAME" -p 127.0.0.1::5000 registry:2 >/dev/null
REGISTRY=localhost:$(docker port "$REGISTRY_NAME" 5000/tcp | head -n 1 | sed 's/.*://')

build_node() { # name, version, crashes-on-start
	docker build -q -t "$REGISTRY/stub/$1:$2" --build-arg "VERSION=$2" --build-arg "BAD=$3" - >/dev/null <<'EOF'
FROM node:24-slim
ARG VERSION
ARG BAD=0
ENV STUB_VERSION=$VERSION STUB_BAD=$BAD
RUN printf '%s\n' \
  'if (process.env.STUB_BAD === "1") process.exit(1);' \
  'require("http").createServer((req, res) => { res.writeHead(200); res.end(process.env.STUB_VERSION); }).listen(3000, "0.0.0.0");' \
  > /server.js
USER node
CMD ["node", "/server.js"]
EOF
	docker push -q "$REGISTRY/stub/$1:$2" >/dev/null
}

build_python() { # name, version, migration-exit-code, migration-seconds
	docker build -q -t "$REGISTRY/stub/$1:$2" --build-arg "VERSION=$2" --build-arg "MIGRATE_EXIT=$3" --build-arg "MIGRATE_SECONDS=$4" - >/dev/null <<'EOF'
FROM python:3.12-slim
ARG VERSION
ARG MIGRATE_EXIT=0
ARG MIGRATE_SECONDS=0
ENV STUB_VERSION=$VERSION MIGRATE_EXIT=$MIGRATE_EXIT MIGRATE_SECONDS=$MIGRATE_SECONDS
WORKDIR /app
# A stand-in for `python -m alembic upgrade head`, and a server for the health check.
RUN mkdir alembic && printf '%s\n' 'import os, sys, time' 'time.sleep(int(os.environ["MIGRATE_SECONDS"]))' 'sys.exit(int(os.environ["MIGRATE_EXIT"]))' > alembic/__main__.py \
  && printf '%s\n' 'from http.server import BaseHTTPRequestHandler, HTTPServer' \
  'class H(BaseHTTPRequestHandler):' \
  '    def do_GET(self):' \
  '        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")' \
  '    def log_message(self, *a): pass' \
  'HTTPServer(("0.0.0.0", 8000), H).serve_forever()' > server.py
USER nobody
CMD ["python", "/app/server.py"]
EOF
	docker push -q "$REGISTRY/stub/$1:$2" >/dev/null
}

build_worker() {
	docker build -q -t "$REGISTRY/stub/worker:v1" - >/dev/null <<'EOF'
FROM python:3.12-slim
USER nobody
CMD ["python", "-c", "import time\nwhile True: time.sleep(3600)"]
EOF
	docker push -q "$REGISTRY/stub/worker:v1" >/dev/null
}

digest_of() { docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/stub/$1:$2"; }

build_node api v1 0
build_node api v2 0
build_node api v3 0
build_node api crash 1
build_node web v1 0
build_node web v2 0
build_node web v3 0
build_python ai v1 0 0
build_python ai v2 0 4
build_python ai v3 0 0
build_python ai migration-fails 1 0
build_worker

# ---- the staging Compose file, with only the host paths and ports changed ---------------------------------
mkdir -p "$DEPLOY_DIR" "$CONF_DIR"
sed -e "s#/etc/linguamentor#$CONF_DIR#g" -e 's#"127.0.0.1:300[01]:3000"#"127.0.0.1::3000"#' \
	"$ROOT/infra/staging/docker-compose.yml" >"$DEPLOY_DIR/docker-compose.yml"

COMMIT_1=$(printf 'a%.0s' {1..40})
COMMIT_2=$(printf 'b%.0s' {1..40})
RUN_URL=https://github.com/example/repo/actions/runs/1

deploy() { # commit, api, ai, web  (worker never changes)
	"$DEPLOY" deploy --commit "$1" --run "$RUN_URL" --api-gateway "$(digest_of api "$2")" \
		--ai-service "$(digest_of ai "$3")" --worker "$(digest_of worker v1)" --web "$(digest_of web "$4")"
}

env_value() { sed -n "s/^$2=//p" "$DEPLOY_DIR/$1"; }
container_id() {
	docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter "label=com.docker.compose.service=$1"
}
running_version() { docker exec "$(container_id api-gateway)" node -e 'process.stdout.write(process.env.STUB_VERSION)'; }
log_results() { sed -E 's/.*"result":"([a-z_]+)".*/\1/' "$DEPLOY_DIR/deploys.log" | tr '\n' ' '; }

# ---- secrets ---------------------------------------------------------------------------------------------
printf 'ENFORCE_CALIBRATION_GATE=false\nDATABASE_URL=old\n' >"$CONF_DIR/staging.env"
mkdir -m 0700 "$CONF_DIR/keys"
# As on the host: the config directory is read-only to the deploy user, and only the files inside it are theirs.
chmod 0555 "$CONF_DIR"
{
	# shellcheck disable=SC2016  # the "$" in the password must stay literal
	printf 'DATABASE_URL=%s\n' "$(printf '%s' 'postgresql://u:p$a$$word@db.example/x?sslmode=require' | base64 -w0)"
	printf 'JWT_PRIVATE_KEY=%s\n' "$(printf '%s' 'fake private key, only checked for its file mode' | base64 -w0)"
	printf 'JWT_PUBLIC_KEY=%s\n' "$(printf '%s' 'fake public key, only checked for its file mode' | base64 -w0)"
} | "$DEPLOY" sync-secrets >/dev/null
check "secrets: the database URL is replaced and kept literal, other settings stay" \
	test "$(grep -c '^DATABASE_URL=' "$CONF_DIR/staging.env")" = 1 \
	-a "$(grep '^DATABASE_URL=' "$CONF_DIR/staging.env")" = "DATABASE_URL='postgresql://u:p\$a\$\$word@db.example/x?sslmode=require'" \
	-a "$(grep -c '^ENFORCE_CALIBRATION_GATE=false' "$CONF_DIR/staging.env")" = 1
check "secrets: file modes are 0600 for the env file and private key, 0644 for the public key" \
	test "$(stat -c %a "$CONF_DIR/staging.env" "$CONF_DIR/keys/jwt_private.pem" "$CONF_DIR/keys/jwt_public.pem" | tr '\n' ' ')" = "600 600 644 "
check "secrets: an unknown name is refused" bash -c "! printf 'X=eQ==\n' | $DEPLOY sync-secrets"
: >"$CONF_DIR/staging.env"

# ---- a first deploy, then a second ---------------------------------------------------------------------------
check "a tag instead of a digest is refused" bash -c "! $DEPLOY deploy --commit $COMMIT_1 --run $RUN_URL --api-gateway nginx:latest --ai-service x --worker x --web x"
check "a digest that does not exist fails the pull with exit 20 and changes nothing" bash -c "
	set +e; $DEPLOY deploy --commit $COMMIT_1 --run $RUN_URL \
		--api-gateway $REGISTRY/stub/api@sha256:$(printf '0%.0s' {1..64}) --ai-service $(digest_of ai v1) \
		--worker $(digest_of worker v1) --web $(digest_of web v1); [ \$? -eq 20 ] && [ ! -f '$DEPLOY_DIR/images.env' ]"

check "the first deploy succeeds" deploy "$COMMIT_1" v1 v1 v1
check "it recorded the commit and the digests it ran" \
	grep -q "\"commit\":\"$COMMIT_1\".*\"result\":\"deployed\".*\"api-gateway\":\"$(digest_of api v1)\"" "$DEPLOY_DIR/deploys.log"
check "the stack is running release 1" test "$(running_version)" = v1

check "the second deploy succeeds, and the migration ran from the new image" deploy "$COMMIT_2" v2 v2 v2
check "the set it replaced is kept as images.env.previous" \
	test "$(env_value images.env.previous API_GATEWAY_IMAGE)" = "$(digest_of api v1)"
check "the stack is running release 2" test "$(running_version)" = v2

# ---- failures ------------------------------------------------------------------------------------------------
api_before=$(container_id api-gateway)
status=0
"$DEPLOY" deploy --commit "$COMMIT_2" --run "$RUN_URL" --api-gateway "$(digest_of api v3)" \
	--ai-service "$(digest_of ai migration-fails)" --worker "$(digest_of worker v1)" --web "$(digest_of web v3)" >/dev/null 2>&1 || status=$?
check "a failing migration exits 21" test "$status" = 21
check "a failing migration leaves the running containers and images.env untouched" \
	test "$(container_id api-gateway)" = "$api_before" -a "$(env_value images.env API_GATEWAY_IMAGE)" = "$(digest_of api v2)"

status=0
"$DEPLOY" deploy --commit "$COMMIT_2" --run "$RUN_URL" --api-gateway "$(digest_of api crash)" \
	--ai-service "$(digest_of ai v3)" --worker "$(digest_of worker v1)" --web "$(digest_of web v3)" >/dev/null 2>&1 || status=$?
check "containers that never become healthy exit 30" test "$status" = 30
check "and staging went back to the previous images by itself" \
	test "$(env_value images.env API_GATEWAY_IMAGE)" = "$(digest_of api v2)" -a "$(running_version)" = v2
check "the bad set is kept as images.env.rolled-back" \
	test "$(env_value images.env.rolled-back API_GATEWAY_IMAGE)" = "$(digest_of api crash)"

# ---- manual rollback, and two deploys at once ---------------------------------------------------------------
check "a good release 3 deploys" deploy "$COMMIT_2" v3 v3 v3
"$DEPLOY" rollback --commit "$COMMIT_2" --run "$RUN_URL" --reason smoke_failed >/dev/null 2>&1 || true
check "a manual rollback returns to release 2" test "$(running_version)" = v2
check "a second rollback is a harmless no-op" "$DEPLOY" rollback --commit "$COMMIT_2" --run "$RUN_URL" --reason again

# Release 2's migration sleeps 4 s. Two deploys that overlapped would finish in about 5 s; queued ones cannot.
started=$(date +%s)
(deploy "$COMMIT_1" v1 v2 v1 >/dev/null 2>&1 &
	deploy "$COMMIT_2" v2 v2 v2 >/dev/null 2>&1 &
	wait)
elapsed=$(($(date +%s) - started))
check "two deploys started together run one after the other (took ${elapsed}s)" test "$elapsed" -ge 8

echo "log: $(log_results)"
if ((failures > 0)); then
	printf '%d check(s) failed\n' "$failures" >&2
	exit 1
fi
echo "All staging deploy checks passed."
