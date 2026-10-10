import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { scrubErrorEvent } from "@lingumentor/shared-schemas";
import * as Sentry from "@sentry/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { flushMonitoring, initMonitoring } from "../src/observability/monitoring";
import { bearerHeader, buildTestApp, makeFakeDb, signTestAccessToken } from "./helpers";

const ESSAY = "ESSAY-MARKER-9b2e Public transport should be free for everyone in large cities.";

describe("error reports", () => {
	const envelopes: string[] = [];
	const saved = { ...process.env };

	beforeAll(() => {
		Object.assign(process.env, {
			SENTRY_DSN: "http://publickey@127.0.0.1:9/3",
			SENTRY_ENVIRONMENT: "test-environment",
			SENTRY_RELEASE: "0123abc",
		});
		// Records what would have gone to Bugsink instead of sending it.
		initMonitoring((options) =>
			Sentry.createTransport(options, async (request) => {
				envelopes.push(
					typeof request.body === "string"
						? request.body
						: Buffer.from(request.body).toString("utf8"),
				);
				return { statusCode: 200 };
			}),
		);
	});

	afterAll(async () => {
		await Sentry.close();
		process.env = saved;
	});

	it("reports a 500 with environment, release and request id, and without the essay", async () => {
		const driverError = Object.assign(new Error("insert failed"), {
			detail: `Failing row contains (${ESSAY}).`,
		});
		const db = makeFakeDb([{ match: "INSERT INTO writing_sessions", throws: driverError }]);
		const { app, jwt } = await buildTestApp({ db, logStream: { write: () => undefined } });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			headers: { ...bearerHeader(token), "x-request-id": "req-report-1", cookie: "session=secret" },
			payload: { exam_type: "ielts_academic", prompt_text: "Discuss.", essay_text: ESSAY },
		});
		await flushMonitoring();

		expect(res.statusCode).toBe(500);
		const sent = envelopes.join("\n");
		const events = sent
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((item) => item.exception);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			environment: "test-environment",
			release: "0123abc",
			tags: { requestId: "req-report-1", service: "api-gateway" },
			exception: { values: [{ type: "Error", value: "insert failed" }] },
		});
		expect(sent).not.toContain("ESSAY-MARKER-9b2e");
		expect(sent).not.toContain("session=secret");
	});
});

describe("scrubErrorEvent", () => {
	it("keeps the error and the path, and drops everything that can carry personal data", () => {
		const event = scrubErrorEvent({
			request: {
				url: "https://staging.example/reset?token=abc#email=a@b.c",
				data: { essay_text: ESSAY },
				cookies: { session: "x" },
				headers: { authorization: "Bearer y" },
				query_string: "token=abc",
			},
			user: { id: "u1", email: "learner@example.com" },
			extra: { essay: ESSAY },
			exception: { values: [{ stacktrace: { frames: [{ vars: { essay_text: ESSAY } }] } }] },
			breadcrumbs: [{ data: { url: "/api/v1/user/me?email=learner@example.com", method: "GET" } }],
		});

		expect(event).toEqual({
			request: { url: "https://staging.example/reset" },
			exception: { values: [{ stacktrace: { frames: [{}] } }] },
			breadcrumbs: [{ data: { url: "/api/v1/user/me", method: "GET" } }],
		});
	});
});

describe("POST /api/v1/monitoring/envelope", () => {
	const received: { url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
	let bugsink: ReturnType<typeof createServer>;
	let bugsinkPort = 0;

	beforeAll(async () => {
		bugsink = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				received.push({
					url: req.url,
					headers: req.headers,
					body: Buffer.concat(chunks).toString(),
				});
				res.writeHead(200).end("{}");
			});
		});
		await new Promise<void>((resolve) => bugsink.listen(0, "127.0.0.1", resolve));
		bugsinkPort = (bugsink.address() as AddressInfo).port;
	});
	afterAll(() => bugsink.close());
	afterEach(() => void received.splice(0));

	const browserEnvelope = [
		JSON.stringify({ event_id: "e1", dsn: "https://placeholder@browser.invalid/0" }),
		JSON.stringify({ type: "event" }),
		JSON.stringify({ message: "TypeError: x is undefined", environment: "staging" }),
	].join("\n");

	it("relays to the web project only, with its DSN swapped in", async () => {
		const { app } = await buildTestApp({
			webErrorsDsn: `http://webkey@127.0.0.1:${bugsinkPort}/7`,
		});
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/monitoring/envelope",
			headers: { "content-type": "text/plain;charset=UTF-8" },
			payload: browserEnvelope,
		});

		expect(res.statusCode).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0].url).toBe("/api/7/envelope/");
		expect(received[0].headers["x-sentry-auth"]).toContain("sentry_key=webkey");
		const [header, ...items] = received[0].body.split("\n");
		expect(JSON.parse(header)).toEqual({
			event_id: "e1",
			dsn: `http://webkey@127.0.0.1:${bugsinkPort}/7`,
		});
		expect(items).toEqual(browserEnvelope.split("\n").slice(1));
	});

	it("drops reports when no web project is configured", async () => {
		const { app } = await buildTestApp();
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/monitoring/envelope",
			headers: { "content-type": "text/plain" },
			payload: browserEnvelope,
		});
		expect(res.statusCode).toBe(204);
		expect(received).toHaveLength(0);
	});

	it("refuses a body over 256 KB instead of forwarding it", async () => {
		const { app } = await buildTestApp({
			webErrorsDsn: `http://webkey@127.0.0.1:${bugsinkPort}/7`,
		});
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/monitoring/envelope",
			headers: { "content-type": "text/plain" },
			payload: browserEnvelope + "x".repeat(256 * 1024),
		});
		expect(res.statusCode).toBe(413);
		expect(received).toHaveLength(0);
	});

	it("rejects a body whose first line is not an envelope header", async () => {
		const { app } = await buildTestApp({
			webErrorsDsn: `http://webkey@127.0.0.1:${bugsinkPort}/7`,
		});
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/monitoring/envelope",
			headers: { "content-type": "text/plain" },
			payload: "not json\n{}",
		});
		expect(res.statusCode).toBe(400);
		expect(received).toHaveLength(0);
	});

	it("answers 502 when Bugsink cannot be reached", async () => {
		const { app } = await buildTestApp({
			webErrorsDsn: "http://webkey@127.0.0.1:9/7",
			logStream: { write: () => undefined },
		});
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/monitoring/envelope",
			headers: { "content-type": "text/plain" },
			payload: browserEnvelope,
		});
		expect(res.statusCode).toBe(502);
	});
});
