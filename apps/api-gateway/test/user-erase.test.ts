import { describe, expect, it } from "vitest";

import {
	LEARNER_PROFILE_ID,
	bearerHeader,
	buildTestApp,
	makeFakeDb,
	signTestAccessToken,
} from "./helpers";

const ERASE_URL = "/api/v1/user/me";

function erasableDb(opts: { alreadyErased?: boolean } = {}) {
	return makeFakeDb([
		// The guarded UPDATE returns no row when the account is already erased.
		{ match: "UPDATE users", rows: opts.alreadyErased ? [] : [{ id: "u-1" }] },
		{ match: "FROM learner_profiles", rows: [{ id: LEARNER_PROFILE_ID }] },
	]);
}

function statements(db: ReturnType<typeof erasableDb>) {
	return db.calls.map((c) => c.text);
}

describe("DELETE /api/v1/user/me — GDPR erasure (ADR 0007)", () => {
	it("anonymises the identity and deactivates the account", async () => {
		const db = erasableDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "DELETE",
			url: ERASE_URL,
			headers: bearerHeader(token),
		});

		expect(res.statusCode).toBe(204);
		const update = statements(db).find((s) => s.includes("UPDATE users"))!;
		expect(update).toContain("@erased.invalid");
		expect(update).toContain("is_active = false");
		expect(update).toContain("gdpr_erasure_requested_at = now()");
	});

	it("clears every learner-authored free-text field", async () => {
		const db = erasableDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		await app.inject({ method: "DELETE", url: ERASE_URL, headers: bearerHeader(token) });

		const sql = statements(db).join("\n");
		expect(sql).toContain("UPDATE writing_sessions");
		expect(sql).toContain("essay_text = ''");
		// Feedback quotes the essay, so it leaks the same content.
		expect(sql).toContain("category_1_feedback = NULL");
		expect(sql).toContain("UPDATE score_appeals");
		expect(sql).toContain("UPDATE speaking_sessions");
		expect(sql).toContain("UPDATE lesson_messages");
		expect(sql).toContain("content = ''");
		expect(sql).toContain("UPDATE lesson_sessions");
	});

	it("never touches ai_model_runs — the calibration audit trail is not the learner's to delete", async () => {
		const db = erasableDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		await app.inject({ method: "DELETE", url: ERASE_URL, headers: bearerHeader(token) });

		// PRD §10.5 anonymises these logs rather than purging them; ADR 0006's
		// pipeline-integrity gate depends on the corpus surviving erasure.
		expect(statements(db).join("\n")).not.toContain("ai_model_runs");
	});

	it("deletes nothing — erasure is a state transition, not a row delete", async () => {
		const db = erasableDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		await app.inject({ method: "DELETE", url: ERASE_URL, headers: bearerHeader(token) });

		expect(statements(db).join("\n")).not.toContain("DELETE FROM");
	});

	it("stores a password hash that is still a valid argon2 hash", async () => {
		// auth.service.ts verifies the stored hash before it checks is_active —
		// a blank would throw there and turn a login into a 500 instead of a 401.
		const db = erasableDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		await app.inject({ method: "DELETE", url: ERASE_URL, headers: bearerHeader(token) });

		const call = db.calls.find((c) => c.text.includes("UPDATE users"))!;
		expect(String(call.params![2])).toMatch(/^\$argon2id\$/);
	});

	it("clears the refresh cookie so the browser stops presenting it", async () => {
		const db = erasableDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "DELETE",
			url: ERASE_URL,
			headers: bearerHeader(token),
		});

		expect(res.headers["set-cookie"]).toBeDefined();
	});

	it("returns 404 when the account was already erased", async () => {
		const db = erasableDb({ alreadyErased: true });
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "DELETE",
			url: ERASE_URL,
			headers: bearerHeader(token),
		});

		expect(res.statusCode).toBe(404);
		// Guarded by gdpr_erasure_requested_at IS NULL — a re-run must not
		// re-anonymise and hand back a fresh 204.
		expect(statements(db).join("\n")).not.toContain("UPDATE writing_sessions");
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		const res = await app.inject({ method: "DELETE", url: ERASE_URL });

		expect(res.statusCode).toBe(401);
	});
});
