import { describe, expect, it } from "vitest";

import {
	LEARNER_PROFILE_ID,
	bearerHeader,
	buildTestApp,
	makeFakeDb,
	signTestAccessToken,
} from "./helpers";

const CURRENT_URL = "/api/v1/voice/persona/current";
const SELECT_URL = "/api/v1/voice/persona/select";

function personaDb(current = "companion") {
	return makeFakeDb([
		{ match: "FROM learner_profiles", rows: [{ default_persona: current }] },
		{ match: "UPDATE learner_profiles", rows: [{ default_persona: "coach" }] },
	]);
}

/** Tier rides in the JWT, so a tier claim is how a test becomes Pro. */
function proToken(jwt: Parameters<typeof signTestAccessToken>[0]) {
	return signTestAccessToken(jwt, { tier: "pro" });
}

describe("GET /api/v1/voice/persona/current (PRD §35.3)", () => {
	it("returns the learner's persona and what their tier may use", async () => {
		const { app, jwt } = await buildTestApp({ db: personaDb() });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: CURRENT_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		expect(res.json().current).toBe("companion");
	});

	it("offers a free learner Companion only (§17.4)", async () => {
		const { app, jwt } = await buildTestApp({ db: personaDb() });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "GET", url: CURRENT_URL, headers: bearerHeader(token) });

		expect(res.json().available.map((p: { persona: string }) => p.persona)).toEqual(["companion"]);
	});

	it("offers a Pro learner all three", async () => {
		const { app, jwt } = await buildTestApp({ db: personaDb() });
		const token = await proToken(jwt);

		const res = await app.inject({ method: "GET", url: CURRENT_URL, headers: bearerHeader(token) });

		expect(res.json().available.map((p: { persona: string }) => p.persona)).toEqual([
			"companion",
			"coach",
			"examiner",
		]);
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		expect((await app.inject({ method: "GET", url: CURRENT_URL })).statusCode).toBe(401);
	});
});

describe("POST /api/v1/voice/persona/select (PRD §35.3)", () => {
	it("stores a Pro learner's choice against their profile", async () => {
		const db = personaDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await proToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: SELECT_URL,
			headers: bearerHeader(token),
			payload: { persona: "coach" },
		});

		expect(res.statusCode).toBe(200);
		expect(res.json().current).toBe("coach");
		const update = db.calls.find((c) => c.text.includes("UPDATE learner_profiles"))!;
		// Scoped to the caller's own profile, taken from the token.
		expect(update.params).toEqual([LEARNER_PROFILE_ID, "coach"]);
	});

	it("refuses a Pro-only persona on the free tier (§17.4)", async () => {
		const db = personaDb();
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: SELECT_URL,
			headers: bearerHeader(token),
			payload: { persona: "examiner" },
		});

		expect(res.statusCode).toBe(403);
		expect(res.json().error.code).toBe("PRO_TIER_REQUIRED");
		// Nothing was written — the gate runs before the UPDATE.
		expect(db.calls.some((c) => c.text.includes("UPDATE learner_profiles"))).toBe(false);
	});

	it("lets a free learner select Companion — their only option is still a choice", async () => {
		const { app, jwt } = await buildTestApp({
			db: makeFakeDb([
				{ match: "FROM learner_profiles", rows: [{ default_persona: "companion" }] },
				{ match: "UPDATE learner_profiles", rows: [{ default_persona: "companion" }] },
			]),
		});
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: SELECT_URL,
			headers: bearerHeader(token),
			payload: { persona: "companion" },
		});

		expect(res.statusCode).toBe(200);
	});

	it("rejects a persona that isn't one", async () => {
		const { app, jwt } = await buildTestApp({ db: personaDb() });
		const token = await proToken(jwt);

		const res = await app.inject({
			method: "POST",
			url: SELECT_URL,
			headers: bearerHeader(token),
			payload: { persona: "drill_sergeant" },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		const res = await app.inject({
			method: "POST",
			url: SELECT_URL,
			payload: { persona: "coach" },
		});

		expect(res.statusCode).toBe(401);
	});
});
