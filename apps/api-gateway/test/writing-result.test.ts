import { describe, expect, it } from "vitest";

import {
	LEARNER_PROFILE_ID,
	SESSION_ID,
	bearerHeader,
	buildTestApp,
	makeFakeDb,
	signTestAccessToken,
} from "./helpers";

function resultUrl(id = SESSION_ID) {
	return `/api/v1/writing/result/${id}`;
}

function scoredRow(overrides: Record<string, unknown> = {}) {
	return {
		id: SESSION_ID,
		status: "scored",
		exam_type: "toefl_ibt",
		word_count: 312,
		overall_band_score: "6.50", // pg returns NUMERIC as string
		cefr_level: "B2",
		calibration_version: "v1.0-launch",
		submitted_at: new Date("2026-07-08T10:00:00Z"),
		scored_at: new Date("2026-07-08T10:00:05Z"),
		category_1_name: "Development",
		category_1_score: "6.50",
		category_1_weight: "0.333",
		category_1_feedback: "Well developed.",
		category_2_name: "Organization",
		category_2_score: "6.00",
		category_2_weight: "0.333",
		category_2_feedback: "Clear structure.",
		category_3_name: "Language Use",
		category_3_score: "7.00",
		category_3_weight: "0.334",
		category_3_feedback: "Good range.",
		// TOEFL rubric has 3 categories — slot 4 is NULL-padded in the DB
		category_4_name: null,
		category_4_score: null,
		category_4_weight: null,
		category_4_feedback: null,
		grammar_corrections: [{ original: "a", correction: "b", explanation: "c" }],
		vocabulary_suggestions: [],
		...overrides,
	};
}

describe("GET /api/v1/writing/result/:session_id — calibration transparency (PRD §21.3)", () => {
	it("carries the sample count and correlation of the baseline the score ran under", async () => {
		const db = makeFakeDb([
			{
				match: "FROM writing_sessions",
				// Joined from calibration_baselines on the row's own calibration_version.
				rows: [scoredRow({ sample_count: 247, overall_pearson: "0.8800" })],
			},
		]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.json()).toMatchObject({
			calibrated: true,
			calibration_version: "v1.0-launch",
			calibration_sample_count: 247,
			calibration_correlation: "0.8800",
		});
	});

	it("joins the baseline on the score's own version, not whatever is active now", async () => {
		const db = makeFakeDb([{ match: "FROM writing_sessions", rows: [scoredRow()] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		// "This score *was* calibrated against N essays" — a later recalibration
		// must not retroactively re-badge an older score.
		const sql = db.calls.map((c) => c.text).join("\n");
		expect(sql).toContain("cb.calibration_version = ws.calibration_version");
		expect(sql).not.toContain("displayed_on_reports");
	});

	it("leaves the figures null when the baseline row is gone rather than inventing them", async () => {
		const db = makeFakeDb([{ match: "FROM writing_sessions", rows: [scoredRow()] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.json()).toMatchObject({
			calibration_sample_count: null,
			calibration_correlation: null,
		});
	});
});

describe("GET /api/v1/writing/result/:session_id", () => {
	it("returns only status while pending", async () => {
		const db = makeFakeDb([
			{ match: "FROM writing_sessions", rows: [{ id: SESSION_ID, status: "pending" }] },
		]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ session_id: SESSION_ID, status: "pending" });
	});

	it("returns only status when failed", async () => {
		const db = makeFakeDb([
			{ match: "FROM writing_sessions", rows: [{ id: SESSION_ID, status: "failed" }] },
		]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.json()).toEqual({ session_id: SESSION_ID, status: "failed" });
	});

	it("returns the full result when scored, keeping NUMERICs as strings and dropping the NULL 4th category", async () => {
		const db = makeFakeDb([{ match: "FROM writing_sessions", rows: [scoredRow()] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.status).toBe("scored");
		expect(body.overall_band_score).toBe("6.50");
		expect(body.cefr_level).toBe("B2");
		expect(body.calibration_version).toBe("v1.0-launch");
		expect(body.calibrated).toBe(true);
		expect(body.categories).toHaveLength(3);
		expect(body.categories[0]).toEqual({
			name: "Development",
			score: "6.50",
			weight: "0.333",
			feedback: "Well developed.",
		});
		expect(body.grammar_corrections).toHaveLength(1);
		expect(body.submitted_at).toBe("2026-07-08T10:00:00.000Z");
	});

	it("withholds the band when the exam is uncalibrated and the gate is enforced (Phase 0)", async () => {
		const db = makeFakeDb([
			{ match: "FROM writing_sessions", rows: [scoredRow({ calibration_version: null })] },
		]);
		// Gate defaults on (fail-closed) — no enforceCalibrationGate override.
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.status).toBe("awaiting_calibration");
		expect(body.calibrated).toBe(false);
		expect(body.overall_band_score).toBeUndefined();
		expect(body.cefr_level).toBeUndefined();
		expect(body.categories).toBeUndefined();
		expect(body.message).toContain("calibration");
	});

	it("returns a provisional score when uncalibrated but the gate is disabled", async () => {
		const db = makeFakeDb([
			{ match: "FROM writing_sessions", rows: [scoredRow({ calibration_version: null })] },
		]);
		const { app, jwt } = await buildTestApp({ db, enforceCalibrationGate: false });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.status).toBe("scored");
		expect(body.calibrated).toBe(false);
		expect(body.overall_band_score).toBe("6.50");
		expect(body.categories).toHaveLength(3);
	});

	it("checks ownership in the query (session id + learner id from the JWT)", async () => {
		const db = makeFakeDb([{ match: "FROM writing_sessions", rows: [] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.statusCode).toBe(404);
		const select = db.calls.find((c) => c.text.includes("FROM writing_sessions"));
		expect(select?.params).toEqual([SESSION_ID, LEARNER_PROFILE_ID]);
	});

	it("returns a 404 envelope for an unknown or foreign session", async () => {
		const db = makeFakeDb([{ match: "FROM writing_sessions", rows: [] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: resultUrl(), headers: bearerHeader(token) });

		expect(res.statusCode).toBe(404);
		expect(res.json()).toEqual({
			error: { code: "NOT_FOUND", message: "writing session not found" },
		});
	});

	it("rejects a non-UUID session_id param with a 400 envelope", async () => {
		const { app, jwt } = await buildTestApp();
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "GET",
			url: resultUrl("nope"),
			headers: bearerHeader(token),
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("VALIDATION_ERROR");
		expect(res.json().error.field).toBe("session_id");
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		const res = await app.inject({ method: "GET", url: resultUrl() });

		expect(res.statusCode).toBe(401);
		expect(res.json().error.code).toBe("UNAUTHORIZED");
	});
});
