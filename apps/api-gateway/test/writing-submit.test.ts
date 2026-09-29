import { describe, expect, it } from "vitest";

import {
	LEARNER_PROFILE_ID,
	SESSION_ID,
	bearerHeader,
	buildTestApp,
	makeFakeDb,
	makeFakeQueue,
	signTestAccessToken,
} from "./helpers";

const VALID_BODY = {
	exam_type: "ielts_academic",
	prompt_text: "Some people think that... Discuss.",
	essay_text: "In recent years the debate has intensified. I believe that both views have merit.",
};

async function appWith(
	db = makeFakeDb([{ match: "INSERT INTO writing_sessions", rows: [{ id: SESSION_ID }] }]),
	queue = makeFakeQueue(),
) {
	return buildTestApp({ db, queue });
}

describe("POST /api/v1/writing/submit", () => {
	it("returns 202 with session_id, inserts the row with computed word_count, and enqueues jobId=session_id", async () => {
		const { app, db, queue, jwt } = await appWith();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			headers: bearerHeader(token),
			payload: VALID_BODY,
		});

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ session_id: SESSION_ID, status: "pending" });

		const insert = db.calls.find((c) => c.text.includes("INSERT INTO writing_sessions"));
		expect(insert?.params).toEqual([
			LEARNER_PROFILE_ID,
			VALID_BODY.exam_type,
			VALID_BODY.prompt_text,
			VALID_BODY.essay_text,
			14, // words in essay_text
		]);

		expect(queue.jobs).toHaveLength(1);
		expect(queue.jobs[0].opts.jobId).toBe(SESSION_ID);
		expect(queue.jobs[0].data).toEqual({ session_id: SESSION_ID, exam_type: "ielts_academic" });
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await appWith();

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			payload: VALID_BODY,
		});

		expect(res.statusCode).toBe(401);
		expect(res.json().error.code).toBe("UNAUTHORIZED");
	});

	it("rejects a garbage bearer token", async () => {
		const { app } = await appWith();

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			headers: bearerHeader("not-a-real-token"),
			payload: VALID_BODY,
		});

		expect(res.statusCode).toBe(401);
		expect(res.json().error.code).toBe("UNAUTHORIZED");
	});

	it("rejects a body missing essay_text with a 400 envelope naming the field", async () => {
		const { app, queue, jwt } = await appWith();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			headers: bearerHeader(token),
			payload: { exam_type: "ielts_academic", prompt_text: "p" },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("VALIDATION_ERROR");
		expect(res.json().error.field).toBe("essay_text");
		expect(queue.jobs).toHaveLength(0);
	});

	it("marks the session failed and returns a 500 envelope when enqueue throws", async () => {
		const db = makeFakeDb([{ match: "INSERT INTO writing_sessions", rows: [{ id: SESSION_ID }] }]);
		const queue = makeFakeQueue({ failWith: new Error("redis down") });
		const { app, jwt } = await appWith(db, queue);
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/writing/submit",
			headers: bearerHeader(token),
			payload: VALID_BODY,
		});

		expect(res.statusCode).toBe(500);
		expect(res.json()).toEqual({
			error: { code: "INTERNAL_ERROR", message: "internal server error" },
		});
		const failUpdate = db.calls.find((c) => c.text.includes("SET status = 'failed'"));
		expect(failUpdate?.params).toEqual([SESSION_ID]);
	});
});
