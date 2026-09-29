import { describe, expect, it } from "vitest";

import {
	bearerHeader,
	buildTestApp,
	makeFakeAppealQueue,
	makeFakeDb,
	SESSION_ID,
	signTestAccessToken,
} from "./helpers";

const APPEAL_ID = "9f8e7d6c-bbbb-4aaa-8999-000011112222";
const SUBMIT_URL = `/api/v1/writing/appeal/${SESSION_ID}`;

/** Session row as the eligibility read returns it; the guarded INSERT is
 * stubbed separately so the race path can diverge from the happy path. */
function sessionRow(overrides: Record<string, unknown> = {}) {
	return {
		status: "scored",
		overall_band_score: "6.50",
		calibration_version: "v1.0-launch",
		has_open_appeal: false,
		...overrides,
	};
}

function appealDb(
	opts: { session?: Record<string, unknown> | null; insertRows?: Record<string, unknown>[] } = {},
) {
	return makeFakeDb([
		// The INSERT must be registered first: its guarded SELECT also contains
		// "FROM writing_sessions ws", and first match wins in makeFakeDb.
		{
			match: "INSERT INTO score_appeals",
			rows: opts.insertRows ?? [{ id: APPEAL_ID }],
		},
		{
			match: "AS has_open_appeal",
			rows: opts.session === null ? [] : [sessionRow(opts.session ?? {})],
		},
	]);
}

describe("POST /api/v1/writing/appeal/:session_id", () => {
	it("inserts the appeal and enqueues the pointer job, returning 202", async () => {
		const db = appealDb();
		const appealQueue = makeFakeAppealQueue();
		const { app, jwt } = await buildTestApp({ db, appealQueue });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: SUBMIT_URL,
			headers: bearerHeader(token),
			payload: { appeal_reason: "the grammar score feels too low" },
		});

		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ appeal_id: APPEAL_ID, status: "pending" });

		// Pointer job, idempotent on appeal_id — mirrors the writing_eval contract.
		expect(appealQueue.jobs).toHaveLength(1);
		expect(appealQueue.jobs[0]).toEqual({
			name: "evaluate",
			data: { appeal_id: APPEAL_ID },
			opts: { jobId: APPEAL_ID },
		});

		// The reason made it into the guarded INSERT's params.
		const insert = db.calls.find((c) => c.text.includes("INSERT INTO score_appeals"));
		expect(insert?.params).toEqual([
			SESSION_ID,
			expect.any(String),
			"the grammar score feels too low",
		]);
	});

	it("accepts an empty body — a reason is optional", async () => {
		const db = appealDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: SUBMIT_URL,
			headers: bearerHeader(token),
		});

		expect(res.statusCode).toBe(202);
		const insert = db.calls.find((c) => c.text.includes("INSERT INTO score_appeals"));
		expect(insert?.params?.[2]).toBeNull();
	});

	it("returns 404 for a session the learner doesn't own (or that doesn't exist)", async () => {
		const db = appealDb({ session: null });
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: SUBMIT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(404);
		expect(res.json().error.code).toBe("NOT_FOUND");
	});

	it("returns 409 NOT_SCORED for a session still pending evaluation", async () => {
		const db = appealDb({ session: { status: "pending" } });
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: SUBMIT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("NOT_SCORED");
	});

	it("returns 409 SCORE_WITHHELD when the band was withheld by the Phase 0 gate", async () => {
		// Uncalibrated score + gate enforced: the learner never saw a band, so
		// there is nothing to appeal.
		const db = appealDb({ session: { calibration_version: null } });
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: SUBMIT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("SCORE_WITHHELD");
	});

	it("allows appealing an uncalibrated score when the gate is off (dev mode)", async () => {
		const db = appealDb({ session: { calibration_version: null } });
		const { app, jwt } = await buildTestApp({ db, enforceCalibrationGate: false });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: SUBMIT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(202);
	});

	it("returns 409 APPEAL_PENDING when an appeal is already in progress", async () => {
		const db = appealDb({ session: { has_open_appeal: true } });
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: SUBMIT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("APPEAL_PENDING");
	});

	it("returns 409 APPEAL_PENDING when a concurrent appeal wins the insert race", async () => {
		// Eligibility read says clear, but the guarded INSERT returns no row —
		// the NOT EXISTS re-check caught a concurrent duplicate.
		const db = appealDb({ insertRows: [] });
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: SUBMIT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("APPEAL_PENDING");
	});

	it("marks the appeal failed when enqueueing dies, so no row is stranded pending", async () => {
		const db = appealDb();
		const appealQueue = makeFakeAppealQueue({ failWith: new Error("redis down") });
		const { app, jwt } = await buildTestApp({ db, appealQueue });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: SUBMIT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(500);
		const failUpdate = db.calls.find((c) => c.text.includes("SET status = 'failed'"));
		expect(failUpdate?.params).toEqual([APPEAL_ID]);
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		const res = await app.inject({ method: "POST", url: SUBMIT_URL });

		expect(res.statusCode).toBe(401);
	});
});

describe("GET /api/v1/writing/appeal/:appeal_id", () => {
	const GET_URL = `/api/v1/writing/appeal/${APPEAL_ID}`;

	function appealRow(overrides: Record<string, unknown> = {}) {
		return {
			id: APPEAL_ID,
			writing_session_id: SESSION_ID,
			status: "pending",
			original_score: "6.50",
			secondary_score: null,
			discrepancy_delta: null,
			requires_human_review: false,
			created_at: new Date("2026-07-13T09:00:00Z"),
			resolved_at: null,
			...overrides,
		};
	}

	it("returns a pending appeal without secondary fields", async () => {
		const db = makeFakeDb([{ match: "FROM score_appeals", rows: [appealRow()] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: GET_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.status).toBe("pending");
		expect(body.original_score).toBe("6.50");
		expect(body).not.toHaveProperty("secondary_score");
	});

	it("returns the resolved appeal with delta and human-review flag, NUMERICs as strings", async () => {
		const db = makeFakeDb([
			{
				match: "FROM score_appeals",
				rows: [
					appealRow({
						status: "resolved",
						secondary_score: "7.50",
						discrepancy_delta: "1.00",
						requires_human_review: true,
						resolved_at: new Date("2026-07-13T09:00:45Z"),
					}),
				],
			},
		]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: GET_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.status).toBe("resolved");
		expect(body.secondary_score).toBe("7.50");
		expect(body.discrepancy_delta).toBe("1.00");
		expect(body.requires_human_review).toBe(true);
		expect(body.resolved_at).toBe("2026-07-13T09:00:45.000Z");
	});

	it("explains a failed appeal and that the original score stands (PRD §37.4)", async () => {
		const db = makeFakeDb([
			{ match: "FROM score_appeals", rows: [appealRow({ status: "failed" })] },
		]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: GET_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.status).toBe("failed");
		expect(body.message).toContain("original score stands");
	});

	it("returns 404 for an appeal the learner doesn't own", async () => {
		const db = makeFakeDb([{ match: "FROM score_appeals", rows: [] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: GET_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(404);
	});
});
