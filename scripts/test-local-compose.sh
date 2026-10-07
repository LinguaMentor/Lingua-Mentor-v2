#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT="linguamentor-compose-smoke-$RANDOM-$$"
COMPOSE=(docker compose --project-name "$PROJECT" -f "$ROOT/infra/docker-compose.yml")

cleanup() {
	"${COMPOSE[@]}" down -v --remove-orphans >/dev/null || true
}
trap cleanup EXIT

"${COMPOSE[@]}" up --build -d --wait --wait-timeout 120

for mapping in "postgres 5432" "redis 6379" "api-gateway 3000" "ai-service 8000"; do
	read -r service port <<<"$mapping"
	address=$("${COMPOSE[@]}" port "$service" "$port")
	[[ "$address" == 127.0.0.1:* ]] || {
		printf 'Expected %s port %s to bind to 127.0.0.1, got %s\n' "$service" "$port" "$address" >&2
		exit 1
	}
done

"${COMPOSE[@]}" exec -T api-gateway node -e 'require("node:http").get("http://ai-service:8000/health", response => { response.resume(); if (response.statusCode !== 200) process.exitCode = 1; }).on("error", error => { console.error(error); process.exitCode = 1; });'

email="compose-smoke-$(date +%s)-$RANDOM@example.com"
status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
	-X POST http://127.0.0.1:3000/api/v1/auth/register \
	-H 'content-type: application/json' \
	-d "{\"email\":\"$email\",\"password\":\"correct-horse-battery\",\"display_name\":\"Compose Smoke\",\"target_language\":\"en\"}")
[[ "$status" == 201 ]] || {
	printf 'Expected registration HTTP 201, got %s\n' "$status" >&2
	exit 1
}

stored_email=$("${COMPOSE[@]}" exec -T postgres psql -U linguamentor -d linguamentor \
	-Atc "SELECT email FROM users WHERE email = '$email';")
[[ "$stored_email" == "$email" ]] || {
	printf 'Registered email was not found in the Compose database: %s\n' "$email" >&2
	exit 1
}

printf 'Local Compose smoke test passed.\n'