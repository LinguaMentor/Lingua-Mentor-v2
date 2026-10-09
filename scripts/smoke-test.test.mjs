// Run with `node --test scripts/`. Starts a stub API and runs the real script against it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

const SCRIPT = new URL("./smoke-test.mjs", import.meta.url).pathname;

let server;
let baseUrl;
let calls;
let behaviour;

function defaultBehaviour() {
	return {
		readyStatuses: [200],
		readyRedirectTo: undefined,
		registerStatus: 201,
		loginStatus: 200,
		writingStatuses: ["pending", "processing", "scored"],
		eraseStatus: 204,
	};
}

function sendJson(response, status, body) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(body === undefined ? "" : JSON.stringify(body));
}

function handle(request, response) {
	const route = `${request.method} ${request.url}`;
	calls.push({ route, headers: request.headers });

	if (route === "GET /api/v1/health/ready") {
		if (behaviour.readyRedirectTo) {
			response.writeHead(302, { location: behaviour.readyRedirectTo });
			return response.end();
		}
		// The last status repeats once the list runs out.
		const status =
			behaviour.readyStatuses.length > 1
				? behaviour.readyStatuses.shift()
				: behaviour.readyStatuses[0];
		return sendJson(response, status, {});
	}
	if (route === "POST /api/v1/auth/register")
		return sendJson(response, behaviour.registerStatus, { access_token: "register-token" });
	if (route === "POST /api/v1/auth/login")
		return sendJson(response, behaviour.loginStatus, { access_token: "login-token" });
	if (route === "GET /api/v1/writing/exams")
		return sendJson(response, 200, [
			{ exam_id: "delf_b1", language: "fr" },
			{ exam_id: "ielts_academic", language: "en" },
		]);
	if (route === "POST /api/v1/writing/submit")
		return sendJson(response, 202, { session_id: "session-1", status: "pending" });
	if (route === "GET /api/v1/writing/result/session-1") {
		const status = behaviour.writingStatuses.shift() ?? "processing";
		return sendJson(response, 200, { session_id: "session-1", status });
	}
	if (route === "DELETE /api/v1/user/me") return sendJson(response, behaviour.eraseStatus);
	return sendJson(response, 404, { error: { code: "NOT_FOUND" } });
}

function runSmokeTest(env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SCRIPT], {
			env: {
				PATH: process.env.PATH,
				SMOKE_BASE_URL: baseUrl,
				SMOKE_POLL_INTERVAL_MS: "10",
				SMOKE_READY_WAIT_SECONDS: "0",
				SMOKE_WRITING_WAIT_SECONDS: "2",
				...env,
			},
		});
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("close", (code) => resolve({ code, output }));
	});
}

const routesCalled = () => calls.map((call) => call.route);

before(async () => {
	server = createServer(handle);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe("smoke test", () => {
	it("exits 0 and erases its account when every step passes", async () => {
		calls = [];
		behaviour = defaultBehaviour();

		const { code } = await runSmokeTest();

		assert.equal(code, 0);
		assert.deepEqual(
			routesCalled().filter((route) => route.startsWith("DELETE")),
			["DELETE /api/v1/user/me"],
		);
		const submit = calls.find((call) => call.route === "POST /api/v1/writing/submit");
		assert.equal(submit.headers.authorization, "Bearer login-token");
	});

	it("exits non-zero and touches nothing else when readiness fails", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), readyStatuses: [503] };

		const { code, output } = await runSmokeTest();

		assert.equal(code, 1);
		assert.match(output, /ready returned 503/);
		assert.deepEqual(routesCalled(), ["GET /api/v1/health/ready"]);
	});

	it("fails on a redirect instead of following it to an Access login page", async () => {
		calls = [];
		behaviour = {
			...defaultBehaviour(),
			readyRedirectTo: "https://team.cloudflareaccess.com/cdn-cgi/access/login/staging",
		};

		const { code, output } = await runSmokeTest();

		assert.equal(code, 1);
		assert.match(output, /readiness: GET .* returned 302 to team\.cloudflareaccess\.com/);
		assert.deepEqual(routesCalled(), ["GET /api/v1/health/ready"]);
	});

	it("names the step that failed", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), registerStatus: 500 };

		const { code, output } = await runSmokeTest();

		assert.equal(code, 1);
		assert.match(output, /FAIL register: POST \/api\/v1\/auth\/register returned 500/);
	});

	it("does not try to erase an account that was never created", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), registerStatus: 500 };

		await runSmokeTest();

		assert.equal(routesCalled().filter((route) => route.startsWith("DELETE")).length, 0);
	});

	it("still erases the account with the registration token when login fails", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), loginStatus: 401 };

		const { code } = await runSmokeTest();

		assert.equal(code, 1);
		const erase = calls.find((call) => call.route === "DELETE /api/v1/user/me");
		assert.equal(erase.headers.authorization, "Bearer register-token");
	});

	it("retries readiness within the wait window", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), readyStatuses: [503, 503, 200] };

		const { code } = await runSmokeTest({ SMOKE_READY_WAIT_SECONDS: "2" });

		assert.equal(code, 0);
		assert.equal(routesCalled().filter((route) => route.endsWith("/health/ready")).length, 3);
	});

	it("exits non-zero but still erases the account when the evaluation fails", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), writingStatuses: ["processing", "failed"] };

		const { code, output } = await runSmokeTest();

		assert.equal(code, 1);
		assert.match(output, /evaluation failed/);
		assert.ok(routesCalled().includes("DELETE /api/v1/user/me"));
	});

	it("exits non-zero when the evaluation never finishes", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), writingStatuses: [] };

		const { code, output } = await runSmokeTest({ SMOKE_WRITING_WAIT_SECONDS: "0" });

		assert.equal(code, 1);
		assert.match(output, /still "processing"/);
	});

	it("treats a withheld score as a finished evaluation", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), writingStatuses: ["awaiting_calibration"] };

		const { code } = await runSmokeTest();

		assert.equal(code, 0);
	});

	it("exits non-zero when the account cannot be erased", async () => {
		calls = [];
		behaviour = { ...defaultBehaviour(), eraseStatus: 500 };

		const { code, output } = await runSmokeTest();

		assert.equal(code, 1);
		assert.match(output, /cleanup failed, remove smoke-/);
	});

	it("sends the Cloudflare Access service token when one is configured", async () => {
		calls = [];
		behaviour = defaultBehaviour();

		await runSmokeTest({ CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "secret" });

		assert.ok(
			calls.every(
				(call) =>
					call.headers["cf-access-client-id"] === "id.access" &&
					call.headers["cf-access-client-secret"] === "secret",
			),
		);
	});

	it("exits 2 without a base URL", async () => {
		const { code } = await runSmokeTest({ SMOKE_BASE_URL: "" });

		assert.equal(code, 2);
	});
});
