#!/usr/bin/env node
// Stand-in for the smoke test until the API has a readiness check (#73): the web page answers, and the API
// answers on the same hostname with a working scoring service and database. Delete it once the smoke test runs after every deploy.
// Usage: STAGING_URL=https://staging.example node scripts/post-deploy-check.mjs
const baseUrl = requiredEnv("STAGING_URL").replace(/\/$/, "");
const waitMs = Number(process.env.CHECK_WAIT_SECONDS ?? 90) * 1000;
const pollMs = Number(process.env.CHECK_POLL_INTERVAL_MS ?? 5000);
const REQUEST_TIMEOUT_MS = 10_000;

const CHECKS = [
	{ name: "web page", method: "GET", path: "/", expected: 200 },
	{ name: "API and scoring service", method: "GET", path: "/api/v1/writing/exams", expected: 200 },
	{
		// An unknown address is only rejected after the database lookup, so a 401 means the database answers.
		name: "API and database",
		method: "POST",
		path: "/api/v1/auth/login",
		body: { email: "deploy-check@example.invalid", password: "not-a-real-password" },
		expected: 401,
	},
];

function requiredEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`${name} is required`);
		process.exit(2);
	}
	return value;
}

function accessHeaders() {
	const id = process.env.CF_ACCESS_CLIENT_ID;
	const secret = process.env.CF_ACCESS_CLIENT_SECRET;
	return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns why the check failed, or undefined when it passed. */
async function failureOf(check) {
	const headers = { ...accessHeaders() };
	if (check.body) headers["content-type"] = "application/json";
	try {
		const response = await fetch(`${baseUrl}${check.path}`, {
			method: check.method,
			headers,
			body: check.body ? JSON.stringify(check.body) : undefined,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			// A followed Access login page would answer 200 and pass for a healthy page.
			redirect: "manual",
		});
		if (response.status === check.expected) return undefined;
		const redirect = response.headers.get("location");
		const target = redirect ? ` to ${new URL(redirect, baseUrl).host}` : "";
		return `${check.method} ${check.path} returned ${response.status}${target}, expected ${check.expected}`;
	} catch (error) {
		return `${check.method} ${check.path} did not answer: ${error.message}`;
	}
}

const deadline = Date.now() + waitMs;
for (;;) {
	const failures = [];
	for (const check of CHECKS) {
		const failure = await failureOf(check);
		if (failure) failures.push(`${check.name}: ${failure}`);
	}
	if (failures.length === 0) break;
	if (Date.now() >= deadline) {
		for (const failure of failures) console.error(`FAIL ${failure}`);
		process.exit(1);
	}
	await sleep(pollMs);
}
for (const check of CHECKS) console.log(`ok   ${check.name}`);
console.log("Post-deploy check passed.");
