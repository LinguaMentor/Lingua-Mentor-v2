import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createAiServiceClient } from "../src/clients/ai-service";
import { runWithRequestId } from "../src/observability/request-context";
import { SESSION_ID, bearerHeader, buildTestApp, makeFakeDb, signTestAccessToken } from "./helpers";

// A known essay: if it shows up in a log line, the test fails.
const ESSAY = "ESSAY-MARKER-4f1c Cities grow while villages empty, and both trends have a cost.";
const SUBMIT = {
	exam_type: "ielts_academic",
	prompt_text: "Discuss both views.",
	essay_text: ESSAY,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function captureLogs() {
	const lines: string[] = [];
	return { lines, logStream: { write: (line: string) => void lines.push(line) } };
}

describe("request ids", () => {
	it("reuses a valid incoming id and returns it", async () => {
		const { app } = await buildTestApp();
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/health",
			headers: { "x-request-id": "edge-7Hq.2:a_b-c" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers["x-request-id"]).toBe("edge-7Hq.2:a_b-c");
	});

	it.each([
		["absent", undefined],
		["empty", ""],
		["too long", "a".repeat(129)],
		["with a space", "two words"],
		["with a newline", "id\nforged log line"],
	])("generates a new id when the incoming one is %s", async (_case, incoming) => {
		const { app } = await buildTestApp();
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/health",
			headers: incoming === undefined ? {} : { "x-request-id": incoming },
		});
		expect(res.headers["x-request-id"]).toMatch(UUID);
	});

	it("puts the id on error responses too", async () => {
		const { app } = await buildTestApp();
		const res = await app.inject({ method: "GET", url: "/api/v1/nowhere" });
		expect(res.statusCode).toBe(404);
		expect(res.headers["x-request-id"]).toMatch(UUID);
	});
});

describe("logs", () => {
	it("writes JSON lines that carry the request id and never the essay", async () => {
		const { lines, logStream } = captureLogs();
		const db = makeFakeDb([{ match: "INSERT INTO writing_sessions", rows: [{ id: SESSION_ID }] }]);
		const { app, jwt, queue } = await buildTestApp({ db, logStream });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			headers: { ...bearerHeader(token), "x-request-id": "req-essay-1" },
			payload: SUBMIT,
		});

		expect(res.statusCode).toBe(202);
		expect(queue.jobs[0].data.request_id).toBe("req-essay-1");
		const entries = lines.map((line) => JSON.parse(line));
		for (const entry of entries) {
			expect(entry).toMatchObject({
				service: "api-gateway",
				level: expect.any(String),
				time: expect.any(String),
			});
		}
		expect(entries.filter((e) => e.requestId === "req-essay-1").map((e) => e.msg)).toEqual(
			expect.arrayContaining(["incoming request", "request completed"]),
		);
		expect(lines.join("")).not.toContain("ESSAY-MARKER-4f1c");
	});

	it("does not log the health probes that run every few seconds", async () => {
		const { lines, logStream } = captureLogs();
		const { app } = await buildTestApp({ logStream });
		await app.inject({ method: "GET", url: "/health" });
		await app.inject({ method: "GET", url: "/api/v1/health" });
		expect(lines).toEqual([]);
	});

	it("logs a failed request's error without the row the driver quoted", async () => {
		const { lines, logStream } = captureLogs();
		const driverError = Object.assign(new Error("new row violates check constraint"), {
			code: "23514",
			detail: `Failing row contains (${ESSAY}).`,
		});
		const db = makeFakeDb([{ match: "INSERT INTO writing_sessions", throws: driverError }]);
		const { app, jwt } = await buildTestApp({ db, logStream });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			headers: bearerHeader(token),
			payload: SUBMIT,
		});

		expect(res.statusCode).toBe(500);
		const failure = lines.map((line) => JSON.parse(line)).find((e) => e.msg === "unhandled error");
		expect(failure.err).toMatchObject({
			message: "new row violates check constraint",
			code: "23514",
		});
		expect(failure.requestId).toBe(res.headers["x-request-id"]);
		expect(lines.join("")).not.toContain("ESSAY-MARKER-4f1c");
	});
});

describe("ai-service client", () => {
	let close: (() => void) | undefined;
	afterEach(() => close?.());

	async function fakeAiService() {
		const seen: IncomingHttpHeaders[] = [];
		const server = createServer((req, res) => {
			seen.push(req.headers);
			res.writeHead(200, { "content-type": "application/json" }).end("[]");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		close = () => server.close();
		const { port } = server.address() as AddressInfo;
		return { seen, client: createAiServiceClient(`http://127.0.0.1:${port}`) };
	}

	it("sends the current request's id", async () => {
		const { seen, client } = await fakeAiService();
		let call: Promise<unknown> = Promise.resolve();
		runWithRequestId("req-to-ai-1", () => {
			call = client.listExams();
		});
		await call;
		expect(seen[0]["x-request-id"]).toBe("req-to-ai-1");
	});

	it("sends no id outside a request", async () => {
		const { seen, client } = await fakeAiService();
		await client.listExams();
		expect(seen[0]["x-request-id"]).toBeUndefined();
	});
});
