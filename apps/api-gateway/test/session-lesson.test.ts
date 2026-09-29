import { describe, expect, it } from "vitest";

import {
	LEARNER_PROFILE_ID,
	LESSON_SESSION_ID,
	bearerHeader,
	buildTestApp,
	makeFakeAiService,
	signTestAccessToken,
} from "./helpers";

const LESSON_URL = "/api/v1/session/lesson";
const messageUrl = (id = LESSON_SESSION_ID) => `${LESSON_URL}/${id}/message`;

describe("POST /api/v1/session/lesson (PRD §35.3)", () => {
	it("starts a lesson for the learner in the JWT", async () => {
		const aiService = makeFakeAiService();
		const { app, jwt } = await buildTestApp({ aiService });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: LESSON_URL,
			headers: bearerHeader(token),
			payload: { topic: "past tenses" },
		});

		expect(res.statusCode).toBe(201);
		expect(res.json().lesson_session_id).toBe(LESSON_SESSION_ID);
		expect(aiService.calls[0].args).toEqual({
			learnerProfileId: LEARNER_PROFILE_ID,
			topic: "past tenses",
		});
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		expect((await app.inject({ method: "POST", url: LESSON_URL, payload: {} })).statusCode).toBe(
			401,
		);
	});
});

describe("POST /api/v1/session/lesson/:id/message — SSE (PRD §19.5)", () => {
	it("streams the mentor turn back as text/event-stream", async () => {
		const { app, jwt } = await buildTestApp();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: messageUrl(),
			headers: bearerHeader(token),
			payload: { message: "I go to school yesterday" },
		});

		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/event-stream");
		expect(res.body).toContain("event: token");
		expect(res.body).toContain('"delta":"Hi"');
		expect(res.body).toContain("event: done");
	});

	it("disables proxy buffering, or nothing arrives until the end", async () => {
		const { app, jwt } = await buildTestApp();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: messageUrl(),
			headers: bearerHeader(token),
			payload: { message: "hello" },
		});

		expect(res.headers["x-accel-buffering"]).toBe("no");
		expect(res.headers["cache-control"]).toContain("no-cache");
	});

	it("passes the learner from the token, never from the caller", async () => {
		const aiService = makeFakeAiService();
		const { app, jwt } = await buildTestApp({ aiService });
		const token = await signTestAccessToken(jwt);

		await app.inject({
			method: "POST",
			url: messageUrl(),
			headers: bearerHeader(token),
			payload: { message: "hello", learner_profile_id: "00000000-0000-0000-0000-000000000000" },
		});

		expect(aiService.calls[0].args).toMatchObject({ learnerProfileId: LEARNER_PROFILE_ID });
	});

	it("rejects an empty message", async () => {
		const { app, jwt } = await buildTestApp();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: messageUrl(),
			headers: bearerHeader(token),
			payload: { message: "   " },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects a message past the length cap", async () => {
		const { app, jwt } = await buildTestApp();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: messageUrl(),
			headers: bearerHeader(token),
			payload: { message: "x".repeat(4001) },
		});

		expect(res.statusCode).toBe(400);
	});

	it("rejects a non-uuid lesson id", async () => {
		const { app, jwt } = await buildTestApp();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: messageUrl("not-a-uuid"),
			headers: bearerHeader(token),
			payload: { message: "hello" },
		});

		expect(res.statusCode).toBe(400);
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		const res = await app.inject({
			method: "POST",
			url: messageUrl(),
			payload: { message: "hello" },
		});

		expect(res.statusCode).toBe(401);
	});
});
