// Each app pins its own ESLint major version (api-gateway: 9/flat-config,
// frontend: 8/.eslintrc — see apps/frontend/next.config.js for why) — so
// staged files have to be linted with *that app's own* locally-installed
// `eslint` binary, not a single repo-root one. `pnpm --filter <app> exec`
// resolves node_modules/.bin/eslint inside the right app, which also makes
// each app's config-file lookup (flat config vs .eslintrc) resolve to the
// version that actually understands it.
//
// Scope is deliberately limited to apps/api-gateway and apps/frontend —
// the two packages that have a working ESLint config. packages/* has no
// lint setup yet (out of scope for this pass); adding it here would just
// make every commit touching shared-schemas fail on a missing config.
//
// Prettier runs after ESLint in the same task so it has the last word on
// layout; globs don't overlap because lint-staged runs separate keys in parallel.
// Python runs through lint-staged too, so files ruff reformats get re-staged.
const py = (app) => (files) => [
	`poetry -C apps/${app} run ruff format ${files.join(" ")}`,
	`poetry -C apps/${app} run ruff check ${files.join(" ")}`,
];

export default {
	"apps/api-gateway/**/*.{ts,tsx}": (files) => [
		`pnpm --filter api-gateway exec eslint --fix ${files.join(" ")}`,
		`prettier --write ${files.join(" ")}`,
	],
	"apps/frontend/**/*.{ts,tsx,js,jsx}": (files) => [
		`pnpm --filter frontend exec eslint --fix ${files.join(" ")}`,
		`prettier --write ${files.join(" ")}`,
	],
	"{apps/api-gateway,apps/frontend}/**/*.{json,css,mjs,cjs}": "prettier --write",
	"packages/**/*.{ts,tsx,js,mjs,cjs,json}": "prettier --write",
	"apps/ai-service/**/*.py": py("ai-service"),
	"apps/worker/**/*.py": py("worker"),
};
