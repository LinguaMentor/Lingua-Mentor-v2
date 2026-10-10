#!/usr/bin/env bash
# Staging deploy steps. The deploy workflow copies this file to the host on every run and calls it over SSH.
#
#   deploy.sh deploy --commit <sha> --run <url> --api-gateway <ref> --ai-service <ref> --worker <ref> --web <ref>
#   deploy.sh rollback --commit <sha> --run <url> --reason <word>
#   deploy.sh sync-secrets        reads NAME=<base64 value> lines on stdin
#
# Every <ref> is an image pinned by digest. Exit codes: 0 done; 20 an image could not be pulled; 21 the
# migration failed (nothing changed); 30 the new containers did not become healthy (rolled back);
# 31 nothing to roll back to; 2 bad usage.
set -euo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/opt/linguamentor/staging}
CONF_DIR=${CONF_DIR:-/etc/linguamentor}
WAIT_TIMEOUT=${WAIT_TIMEOUT:-120}
LOCK_WAIT_SECONDS=${LOCK_WAIT_SECONDS:-900}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-staging}

DIGEST_REF='^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$'
DEPLOY_LOG=$DEPLOY_DIR/deploys.log
NEXT_ENV=$DEPLOY_DIR/images.env.next

log() { echo "==> $*"; }
fail() {
  echo "error: $*" >&2
  exit "${2:-2}"
}

compose() {
  local env_file=$1
  shift
  docker compose -f "$DEPLOY_DIR/docker-compose.yml" --project-directory "$DEPLOY_DIR" --env-file "$env_file" "$@"
}

# The value of one image variable in an env file, empty when the file or the variable is missing.
image_in() {
  local file=$1 name=$2
  [[ -f $file ]] || return 0
  sed -n "s/^${name}=//p" "$file"
}

# One JSON line per deploy action. Every field is checked or fixed text, so no escaping is needed.
record() {
  local result=$1 detail=$2
  printf '{"time":"%s","commit":"%s","run":"%s","result":"%s","detail":"%s","images":{"api-gateway":"%s","ai-service":"%s","worker":"%s","web":"%s"}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "$run" "$result" "$detail" \
    "$(image_in "$DEPLOY_DIR/images.env" API_GATEWAY_IMAGE)" "$(image_in "$DEPLOY_DIR/images.env" AI_SERVICE_IMAGE)" \
    "$(image_in "$DEPLOY_DIR/images.env" WORKER_IMAGE)" "$(image_in "$DEPLOY_DIR/images.env" WEB_IMAGE)" >>"$DEPLOY_LOG"
}

# Two deploys must never migrate or restart at once, whoever started them.
take_lock() {
  exec 9>"$DEPLOY_DIR/.deploy.lock"
  flock -w "$LOCK_WAIT_SECONDS" 9 || fail "another deploy held the lock for ${LOCK_WAIT_SECONDS}s"
}

parse_release_args() {
  commit=""
  run=""
  reason="manual"
  api_gateway=""
  ai_service=""
  worker=""
  web=""
  while (($#)); do
    [[ $# -ge 2 ]] || fail "$1 needs a value"
    case $1 in
      --commit) commit=$2 ;;
      --run) run=$2 ;;
      --reason) reason=$2 ;;
      --api-gateway) api_gateway=$2 ;;
      --ai-service) ai_service=$2 ;;
      --worker) worker=$2 ;;
      --web) web=$2 ;;
      *) fail "unknown option $1" ;;
    esac
    shift 2
  done
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail "--commit must be a full commit SHA"
  [[ $run =~ ^https://[A-Za-z0-9./_?=%-]+$ ]] || fail "--run must be a plain https URL"
  [[ $reason =~ ^[a-z0-9_-]+$ ]] || fail "--reason must be one lowercase word"
}

require_digest_refs() {
  local ref
  for ref in "$api_gateway" "$ai_service" "$worker" "$web"; do
    [[ $ref =~ $DIGEST_REF ]] || fail "'$ref' is not an image pinned by digest"
  done
}

# Puts the previous set back and waits until it is healthy. Migrations are never reversed.
restore_previous() {
  local why=$1
  if [[ ! -f $DEPLOY_DIR/images.env.previous ]]; then
    record no_previous_release "$why"
    fail "nothing to roll back to" 31
  fi
  if cmp -s "$DEPLOY_DIR/images.env" "$DEPLOY_DIR/images.env.previous"; then
    log "already on the previous images"
    return 0
  fi
  mv "$DEPLOY_DIR/images.env" "$DEPLOY_DIR/images.env.rolled-back"
  cp "$DEPLOY_DIR/images.env.previous" "$DEPLOY_DIR/images.env"
  log "rolling back: $why"
  compose "$DEPLOY_DIR/images.env" up -d --wait --wait-timeout "$WAIT_TIMEOUT"
  record rolled_back "$why"
}

cmd_deploy() {
  parse_release_args "$@"
  require_digest_refs
  take_lock
  # A script-level variable: the trap runs after this function has returned.
  trap 'rm -f "$NEXT_ENV"' EXIT

  printf 'API_GATEWAY_IMAGE=%s\nAI_SERVICE_IMAGE=%s\nWORKER_IMAGE=%s\nWEB_IMAGE=%s\n' \
    "$api_gateway" "$ai_service" "$worker" "$web" >"$NEXT_ENV"

  log "pulling images"
  compose "$NEXT_ENV" pull --quiet || {
    record pull_failed "an image could not be pulled"
    fail "an image could not be pulled" 20
  }

  # The migration runs from the new image before anything running is touched, so a failure leaves staging as it was.
  log "migrating"
  compose "$NEXT_ENV" run --rm migrate || {
    record migration_failed "alembic upgrade failed, nothing was changed"
    fail "the migration failed, staging was not changed" 21
  }

  if [[ -f $DEPLOY_DIR/images.env ]] && ! cmp -s "$NEXT_ENV" "$DEPLOY_DIR/images.env"; then
    cp "$DEPLOY_DIR/images.env" "$DEPLOY_DIR/images.env.previous"
  fi
  mv "$NEXT_ENV" "$DEPLOY_DIR/images.env"

  log "starting the new containers"
  if ! compose "$DEPLOY_DIR/images.env" up -d --wait --wait-timeout "$WAIT_TIMEOUT"; then
    record start_failed "containers did not become healthy"
    restore_previous "containers_unhealthy"
    fail "the new containers did not become healthy, staging went back to the previous images" 30
  fi
  record deployed "migrated and healthy"

  # Old images pile up on a small disk; the previous set is recent enough to survive this.
  docker image prune -af --filter "until=168h" >/dev/null || true
  log "deployed $commit"
}

cmd_rollback() {
  parse_release_args "$@"
  take_lock
  restore_previous "$reason"
}

# Writes the one secret this script owns per name, from NAME=<base64> lines. Never echoes a value.
cmd_sync_secrets() {
  umask 077
  local line name encoded value updated
  install -d -m 0700 "$CONF_DIR/keys"
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    name=${line%%=*}
    encoded=${line#*=}
    value=$(printf '%s' "$encoded" | base64 -d) || fail "$name is not valid base64"
    case $name in
      DATABASE_URL)
        [[ $value != *"'"* && $value != *$'\n'* ]] || fail "DATABASE_URL must not contain a quote or a newline"
        # Overwritten in place: the host's config directory is read-only to this user, only the file is theirs.
        # Single quotes keep Compose from expanding a "$" in the password.
        updated=$({ grep -v '^DATABASE_URL=' "$CONF_DIR/staging.env" || true; printf "DATABASE_URL='%s'\n" "$value"; })
        printf '%s\n' "$updated" >"$CONF_DIR/staging.env"
        chmod 0600 "$CONF_DIR/staging.env"
        ;;
      # The gateway runs as root in its container, so 0600 is enough; ai-service mounts only the public key.
      JWT_PRIVATE_KEY)
        printf '%s\n' "$value" >"$CONF_DIR/keys/jwt_private.pem.new"
        mv "$CONF_DIR/keys/jwt_private.pem.new" "$CONF_DIR/keys/jwt_private.pem"
        ;;
      JWT_PUBLIC_KEY)
        printf '%s\n' "$value" >"$CONF_DIR/keys/jwt_public.pem.new"
        chmod 0644 "$CONF_DIR/keys/jwt_public.pem.new"
        mv "$CONF_DIR/keys/jwt_public.pem.new" "$CONF_DIR/keys/jwt_public.pem"
        ;;
      *) fail "unknown secret $name" ;;
    esac
    log "synced $name"
  done
}

main() {
  local command=${1:-}
  [[ -n $command ]] || fail "usage: deploy.sh deploy|rollback|sync-secrets"
  shift
  case $command in
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback "$@" ;;
    sync-secrets) cmd_sync_secrets ;;
    *) fail "unknown command $command" ;;
  esac
}

main "$@"
