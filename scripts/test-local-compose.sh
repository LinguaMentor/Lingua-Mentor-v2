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

for mapping in "postgres 5432" "redis 6379" "api-gateway 3000" "ai-service 8000" "web 3000"; do
	read -r service port <<<"$mapping"
	address=$("${COMPOSE[@]}" port "$service" "$port")
	[[ "$address" == 127.0.0.1:* ]] || {
		printf 'Expected %s port %s to bind to 127.0.0.1, got %s\n' "$service" "$port" "$address" >&2
		exit 1
	}
done

web_uid=$("${COMPOSE[@]}" exec -T web node -e "process.stdout.write(String(process.getuid()))")
[[ "$web_uid" != "0" ]] || {
	printf 'Web container is running as root\n' >&2
	exit 1
}

web_secrets=$("${COMPOSE[@]}" exec -T web node -e '
const fs = require("node:fs");
const path = require("node:path");
const found = [];
function walk(dir) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (/^\.env(\.|$)/.test(entry.name) || /\.(pem|key)$/.test(entry.name)) found.push(full);
	}
}
walk("/app");
if (found.length) {
	console.error(found.join("\n"));
	process.exit(1);
}
')
[[ -z "$web_secrets" ]] || {
	printf 'Web image contained env files or keys:\n%s\n' "$web_secrets" >&2
	exit 1
}

web_base=http://127.0.0.1:3001
landing=$(curl --silent --show-error --fail "$web_base/")
printf '%s' "$landing" | grep -q 'LinguaMentor' || {
	printf 'Landing page did not contain LinguaMentor\n' >&2
	exit 1
}
css_path=$(printf '%s' "$landing" | grep -oE '/_next/static/[^"[:space:]]+\.css' | head -n 1)
[[ -n "$css_path" ]] || {
	printf 'Landing page had no /_next/static CSS link\n' >&2
	exit 1
}
curl --silent --show-error --fail --output /dev/null "$web_base$css_path"
login=$(curl --silent --show-error --fail "$web_base/login")
printf '%s' "$login" | grep -q 'LinguaMentor' || {
	printf 'Login page did not contain LinguaMentor\n' >&2
	exit 1
}
login_css=$(printf '%s' "$login" | grep -oE '/_next/static/[^"[:space:]]+\.css' | head -n 1)
[[ -n "$login_css" ]] || {
	printf 'Login page had no /_next/static CSS link\n' >&2
	exit 1
}
curl --silent --show-error --fail --output /dev/null "$web_base$login_css"
font_path=$(printf '%s' "$login" | grep -oE '/_next/static/[^"[:space:]]+\.woff2' | head -n 1)
[[ -n "$font_path" ]] || {
	printf 'Login page had no /_next/static font\n' >&2
	exit 1
}
curl --silent --show-error --fail --output /dev/null "$web_base$font_path"

"${COMPOSE[@]}" exec -T api-gateway node -e 'require("node:http").get("http://ai-service:8000/health", response => { response.resume(); if (response.statusCode !== 200) process.exitCode = 1; }).on("error", error => { console.error(error); process.exitCode = 1; });'

email="compose-smoke-$(date +%s)-$RANDOM@example.com"
registration=$(mktemp)
status=$(curl --silent --show-error --output "$registration" --write-out '%{http_code}' \
	-X POST http://127.0.0.1:3000/api/v1/auth/register \
	-H 'content-type: application/json' \
	-d "{\"email\":\"$email\",\"password\":\"correct-horse-battery\",\"display_name\":\"Compose Smoke\",\"target_language\":\"en\"}")
[[ "$status" == 201 ]] || {
	printf 'Expected registration HTTP 201, got %s\n' "$status" >&2
	exit 1
}
token=$(jq -r .access_token "$registration")

stored_email=$("${COMPOSE[@]}" exec -T postgres psql -U linguamentor -d linguamentor \
	-Atc "SELECT email FROM users WHERE email = '$email';")
[[ "$stored_email" == "$email" ]] || {
	printf 'Registered email was not found in the Compose database: %s\n' "$email" >&2
	exit 1
}

# One request through the gateway, the worker and ai-service, scored by the fake LLM with no key.
request_id="compose-smoke-$RANDOM-$$"
essay_marker="ESSAY-MARKER-$RANDOM$RANDOM"
submission=$(mktemp)
status=$(curl --silent --show-error --output "$submission" --write-out '%{http_code}' \
	-X POST http://127.0.0.1:3000/api/v1/writing/submit \
	-H 'content-type: application/json' -H "authorization: Bearer $token" -H "x-request-id: $request_id" \
	-d "{\"exam_type\":\"ielts_academic\",\"prompt_text\":\"Discuss both views.\",\"essay_text\":\"$essay_marker Cities grow while villages empty.\"}")
[[ "$status" == 202 ]] || {
	printf 'Expected essay submission HTTP 202, got %s\n' "$status" >&2
	exit 1
}
session_id=$(jq -r .session_id "$submission")

result=""
for _ in $(seq 60); do
	result=$(curl --silent --show-error --fail -H "authorization: Bearer $token" \
		"http://127.0.0.1:3000/api/v1/writing/result/$session_id")
	[[ $(jq -r .status <<<"$result") =~ ^(pending|processing)$ ]] || break
	sleep 1
done
[[ $(jq -r '[.status, .overall_band_score] | join(" ")' <<<"$result") == "scored 6.00" ]] || {
	printf 'Expected the essay scored 6.00 by the fake LLM, got: %s\n' "$result" >&2
	exit 1
}

for service in api-gateway worker ai-service; do
	for _ in $(seq 60); do
		"${COMPOSE[@]}" logs --no-log-prefix --no-color "$service" | grep -q "\"requestId\": *\"$request_id\"" && break
		sleep 1
	done
	"${COMPOSE[@]}" logs --no-log-prefix --no-color "$service" | grep -q "\"requestId\": *\"$request_id\"" || {
		printf 'Request %s never appeared in the %s logs\n' "$request_id" "$service" >&2
		exit 1
	}
	not_json=$("${COMPOSE[@]}" logs --no-log-prefix --no-color "$service" | jq -R -r 'select((try fromjson catch null) | type != "object")')
	[[ -z "$not_json" ]] || {
		printf '%s wrote log lines that are not JSON:\n%s\n' "$service" "$not_json" >&2
		exit 1
	}
done

if "${COMPOSE[@]}" logs --no-color | grep -q "$essay_marker"; then
	printf 'The essay text appeared in the container logs\n' >&2
	exit 1
fi

printf 'Local Compose smoke test passed.\n'