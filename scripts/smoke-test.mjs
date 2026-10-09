#!/usr/bin/env node
// Post-deploy smoke test: readiness, register + login, one writing submission, then erase the account.
// Exits non-zero on any failure so the deploy workflow can roll back. Usage: see infra/staging/README.md.
import { randomBytes } from "node:crypto";

const config = {
	baseUrl: requiredEnv("SMOKE_BASE_URL").replace(/\/$/, ""),
	readyPath: process.env.SMOKE_READY_PATH ?? "/api/v1/health/ready",
	readyWaitMs: secondsEnv("SMOKE_READY_WAIT_SECONDS", 30) * 1000,
	writingWaitMs: secondsEnv("SMOKE_WRITING_WAIT_SECONDS", 120) * 1000,
	pollIntervalMs: Number(process.env.SMOKE_POLL_INTERVAL_MS ?? 2000),
	requestTimeoutMs: secondsEnv("SMOKE_REQUEST_TIMEOUT_SECONDS", 10) * 1000,
	accessClientId: process.env.CF_ACCESS_CLIENT_ID,
	accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
};

// "awaiting_calibration" is a finished evaluation whose score the gate withholds on purpose.
const FINISHED_WRITING_STATUSES = new Set(["scored", "awaiting_calibration"]);

const SMOKE_ESSAY =
	"Smoke test essay. This text is only here to check that a submitted essay travels through " +
	"the API, the queue and the scoring service, and comes back with a finished status.";

class SmokeTestError extends Error {}

function requiredEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`${name} is required`);
		process.exit(2);
	}
	return value;
}

function secondsEnv(name, fallback) {
	return Number(process.env[name] ?? fallback);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function accessHeaders() {
	if (!config.accessClientId || !config.accessClientSecret) return {};
	return {
		"CF-Access-Client-Id": config.accessClientId,
		"CF-Access-Client-Secret": config.accessClientSecret,
	};
}

async function request(method, path, { token, body } = {}) {
	const headers = { ...accessHeaders() };
	if (token) headers.authorization = `Bearer ${token}`;
	if (body !== undefined) headers["content-type"] = "application/json";

	let response;
	try {
		response = await fetch(`${config.baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(config.requestTimeoutMs),
			// An API never redirects; a followed Access login page would answer 200 and pass for a healthy one.
			redirect: "manual",
		});
	} catch (error) {
		throw new SmokeTestError(`${method} ${path} did not answer: ${error.message}`);
	}

	const text = await response.text();
	let json;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		// A non-JSON body (an Access login page, a proxy error) is reported by status below.
	}
	return { status: response.status, json, location: response.headers.get("location") };
}

async function expectStatus(expected, method, path, options) {
	const response = await request(method, path, options);
	if (response.status !== expected) {
		const code = response.json?.error?.code;
		const redirect = response.location
			? ` to ${new URL(response.location, config.baseUrl).host}`
			: "";
		throw new SmokeTestError(
			`${method} ${path} returned ${response.status}${redirect}${code ? ` (${code})` : ""}, expected ${expected}`,
		);
	}
	return response.json;
}

async function step(name, action) {
	const startedAt = Date.now();
	let result;
	try {
		result = await action();
	} catch (error) {
		throw new SmokeTestError(`${name}: ${error.message}`);
	}
	console.log(`ok   ${name} (${Date.now() - startedAt} ms)`);
	return result;
}

async function waitUntilReady() {
	const deadline = Date.now() + config.readyWaitMs;
	for (;;) {
		try {
			await expectStatus(200, "GET", config.readyPath);
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await sleep(config.pollIntervalMs);
		}
	}
}

async function waitForWritingResult(accessToken, sessionId) {
	const deadline = Date.now() + config.writingWaitMs;
	for (;;) {
		const result = await expectStatus(200, "GET", `/api/v1/writing/result/${sessionId}`, {
			token: accessToken,
		});
		if (FINISHED_WRITING_STATUSES.has(result.status)) return result.status;
		if (result.status === "failed") throw new SmokeTestError("the writing evaluation failed");
		if (Date.now() >= deadline) {
			throw new SmokeTestError(
				`the writing evaluation was still "${result.status}" after ${config.writingWaitMs / 1000} s`,
			);
		}
		await sleep(config.pollIntervalMs);
	}
}

async function run() {
	// A fresh, clearly named account per run: no shared secret to keep, and erasing it leaves no essay text behind.
	const account = {
		email: `smoke-${Date.now()}-${randomBytes(4).toString("hex")}@smoke.invalid`,
		password: randomBytes(18).toString("base64url"),
	};
	let accessToken;
	let failure;

	try {
		await step("readiness", waitUntilReady);

		// Keeps the registration token so a failed login still leaves the account erasable.
		accessToken = await step("register", async () => {
			const session = await expectStatus(201, "POST", "/api/v1/auth/register", {
				body: {
					email: account.email,
					password: account.password,
					display_name: "Smoke Test",
					target_language: "en",
				},
			});
			return session.access_token;
		});

		accessToken = await step("login", async () => {
			const session = await expectStatus(200, "POST", "/api/v1/auth/login", {
				body: { email: account.email, password: account.password },
			});
			return session.access_token;
		});

		const status = await step("writing evaluation", async () => {
			const exams = await expectStatus(200, "GET", "/api/v1/writing/exams");
			const exam = exams.find((candidate) => candidate.language === "en");
			if (!exam) throw new SmokeTestError("no English writing exam is configured");

			const submitted = await expectStatus(202, "POST", "/api/v1/writing/submit", {
				token: accessToken,
				body: {
					exam_type: exam.exam_id,
					prompt_text: "Describe your last weekend.",
					essay_text: SMOKE_ESSAY,
				},
			});
			return waitForWritingResult(accessToken, submitted.session_id);
		});
		console.log(`     evaluation finished as "${status}"`);
	} catch (error) {
		failure = error;
	}

	// Runs after a failed step too, so a broken deploy doesn't leave smoke accounts behind.
	if (accessToken) {
		try {
			await step("erase account", () =>
				expectStatus(204, "DELETE", "/api/v1/user/me", { token: accessToken }),
			);
		} catch (error) {
			console.error(`cleanup failed, remove ${account.email} by hand: ${error.message}`);
			failure ??= error;
		}
	}

	if (failure) {
		console.error(`FAIL ${failure.message}`);
		process.exit(1);
	}
	console.log("Smoke test passed.");
}

await run();
