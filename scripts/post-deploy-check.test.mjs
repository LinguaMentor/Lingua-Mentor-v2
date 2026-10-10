// Run with `node --test scripts/`. Starts a stub site and runs the real script against it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

const SCRIPT = new URL("./post-deploy-check.mjs", import.meta.url).pathname;

let server;
let baseUrl;
let calls;
let behaviour;

const healthy = () => ({ web: 200, exams: 200, login: 401, redirectTo: undefined });

function handle(request, response) {
	calls.push({ route: `${request.method} ${request.url}`, headers: request.headers });
	const answer = (status) => {
		response.writeHead(status, behaviour.redirectTo ? { location: behaviour.redirectTo } : {});
		response.end("{}");
	};
	if (request.url === "/") return answer(behaviour.redirectTo ? 302 : behaviour.web);
	if (request.url === "/api/v1/writing/exams") return answer(behaviour.exams);
	if (request.url === "/api/v1/auth/login") return answer(behaviour.login);
	return answer(404);
}

function runCheck(env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SCRIPT], {
			env: {
				PATH: process.env.PATH,
				STAGING_URL: baseUrl,
				CHECK_WAIT_SECONDS: "0",
				CHECK_POLL_INTERVAL_MS: "10",
				...env,
			},
		});
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("close", (code) => resolve({ code, output }));
	});
}

before(async () => {
	server = createServer(handle);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe("post-deploy check", () => {
	it("passes when the page and the API answer as a healthy deploy does", async () => {
		calls = [];
		behaviour = healthy();

		const { code, output } = await runCheck();

		assert.equal(code, 0);
		assert.match(output, /Post-deploy check passed/);
	});

	it("fails when the web page does not answer 200", async () => {
		calls = [];
		behaviour = { ...healthy(), web: 502 };

		const { code, output } = await runCheck();

		assert.equal(code, 1);
		assert.match(output, /web page: GET \/ returned 502/);
	});

	it("fails when the API cannot reach its database: the lookup errors instead of rejecting the login", async () => {
		calls = [];
		behaviour = { ...healthy(), login: 500 };

		const { code, output } = await runCheck();

		assert.equal(code, 1);
		assert.match(
			output,
			/API and database: POST \/api\/v1\/auth\/login returned 500, expected 401/,
		);
	});

	it("fails on a redirect instead of following it to an Access login page", async () => {
		calls = [];
		behaviour = {
			...healthy(),
			redirectTo: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x",
		};

		const { code, output } = await runCheck();

		assert.equal(code, 1);
		assert.match(output, /returned 302 to team\.cloudflareaccess\.com/);
	});

	it("fails when nothing answers", async () => {
		const { code, output } = await runCheck({ STAGING_URL: "http://127.0.0.1:9" });

		assert.equal(code, 1);
		assert.match(output, /did not answer/);
	});

	it("keeps retrying until the wait window ends, and passes once the deploy has come up", async () => {
		calls = [];
		behaviour = { ...healthy(), web: 503 };
		setTimeout(() => (behaviour = healthy()), 150);

		const { code } = await runCheck({ CHECK_WAIT_SECONDS: "3" });

		assert.equal(code, 0);
	});

	it("sends the Cloudflare Access service token when one is configured", async () => {
		calls = [];
		behaviour = healthy();

		await runCheck({ CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "secret" });

		assert.ok(
			calls.every(
				(call) =>
					call.headers["cf-access-client-id"] === "id.access" &&
					call.headers["cf-access-client-secret"] === "secret",
			),
		);
	});

	it("exits 2 without a staging URL", async () => {
		const { code } = await runCheck({ STAGING_URL: "" });

		assert.equal(code, 2);
	});
});
