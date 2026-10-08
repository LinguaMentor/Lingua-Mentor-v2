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