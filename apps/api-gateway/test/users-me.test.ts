import { SignJWT, importPKCS8 } from "jose";
import { describe, expect, it } from "vitest";

import { JWT_ISSUER } from "../src/config/constants";
import { requireRole } from "../src/middleware/authenticate";
import { AppError } from "../src/plugins/error-envelope";
import {
	LEARNER_PROFILE_ID,
	USER_ID,
	bearerHeader,
	buildTestApp,
	makeFakeDb,
	makeTestJwtMaterial,
	signTestAccessToken,
} from "./helpers";

async function signExpiredAccessToken(privateKeyPem: string): Promise<string> {
	const key = await importPKCS8(privateKeyPem, "RS256");
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		role: "learner",
		tier: "free",
		lpid: LEARNER_PROFILE_ID,
		token_use: "access",
	})
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer(JWT_ISSUER)
		.setSubject(USER_ID)
		.setIssuedAt(now - 1000)
		.setExpirationTime(now - 500)
		.sign(key);
}

function dbWithProfile(overrides: Record<string, unknown> = {}) {
	return makeFakeDb([
		{
			match: "FROM users u",
			rows: [
				{
					id: USER_ID,
					email: "learner@example.com",
					display_name: "Existing Learner",
					role: "learner",
					subscription_tier: "pro",
					learner_profile_id: LEARNER_PROFILE_ID,
					target_language: "en",
					target_exam: "ielts_academic",
					accent_target: "en-US",
					default_persona: "companion",
					active_track: "exam",
					cefr_speaking: "B1",
					cefr_listening: null,
					cefr_reading: null,
					cefr_writing: "B2",
					...overrides,
				},
			],
		},
	]);
}

describe("GET /api/v1/user/me", () => {
	it("returns the current user's profile, including the 4D CEFR fields", async () => {
		const { app, jwt } = await buildTestApp({ db: dbWithProfile() });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "GET",
			url: "/api/v1/user/me",
			headers: bearerHeader(token),
		});

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			id: USER_ID,
			email: "learner@example.com",
			display_name: "Existing Learner",
			role: "learner",
			subscription_tier: "pro",
			learner_profile_id: LEARNER_PROFILE_ID,
			target_language: "en",
			target_exam: "ielts_academic",
			accent_target: "en-US",
			default_persona: "companion",
			active_track: "exam",
			cefr_speaking: "B1",
			cefr_listening: null,
			cefr_reading: null,
			cefr_writing: "B2",
		});
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp({ db: dbWithProfile() });

		const res = await app.inject({ method: "GET", url: "/api/v1/user/me" });

		expect(res.statusCode).toBe(401);
		expect(res.json().error.code).toBe("UNAUTHORIZED");
	});

	it("returns TOKEN_EXPIRED for an expired access token", async () => {
		const material = await makeTestJwtMaterial();
		const { app } = await buildTestApp({ db: dbWithProfile(), jwt: material.jwt });
		const expired = await signExpiredAccessToken(material.privateKeyPem);

		const res = await app.inject({
			method: "GET",
			url: "/api/v1/user/me",
			headers: bearerHeader(expired),
		});

		expect(res.statusCode).toBe(401);
		expect(res.json().error.code).toBe("TOKEN_EXPIRED");
	});

	it("returns 404 when the JWT is valid but the account no longer exists", async () => {
		const db = makeFakeDb([{ match: "FROM users u", rows: [] }]);
		const { app, jwt } = await buildTestApp({ db });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({
			method: "GET",
			url: "/api/v1/user/me",
			headers: bearerHeader(token),
		});

		expect(res.statusCode).toBe(404);
		expect(res.json().error.code).toBe("NOT_FOUND");
	});
});

describe("requireRole", () => {
	it("allows a request whose role is in the allowed list", async () => {
		const guard = requireRole("admin", "institution_admin");
		const request = {
			user: { userId: "u1", role: "admin", tier: "pro", learnerProfileId: "lp1" },
		} as never;

		await expect(guard(request, {} as never)).resolves.toBeUndefined();
	});

	it("rejects a request whose role is not in the allowed list with 403 FORBIDDEN", async () => {
		const guard = requireRole("admin");
		const request = {
			user: { userId: "u1", role: "learner", tier: "free", learnerProfileId: "lp1" },
		} as never;

		await expect(guard(request, {} as never)).rejects.toMatchObject(
			new AppError(403, "FORBIDDEN", "you do not have permission to perform this action"),
		);
	});

	it("rejects an unauthenticated request (no request.user)", async () => {
		const guard = requireRole("admin");
		const request = {} as never;

		await expect(guard(request, {} as never)).rejects.toBeInstanceOf(AppError);
	});
});
