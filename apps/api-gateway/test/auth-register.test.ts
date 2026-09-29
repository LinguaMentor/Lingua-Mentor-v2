import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";

import {
	REFRESH_COOKIE_NAME,
	REFRESH_COOKIE_PATH,
	REFRESH_TOKEN_TTL_SECONDS,
} from "../src/config/constants";
import { buildTestApp, makeFakeDb } from "./helpers";

const NEW_USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000";
const NEW_PROFILE_ID = "11111111-2222-4333-8444-555566667777";

const VALID_BODY = {
	email: "new.learner@example.com",
	password: "correct-horse-battery",
	display_name: "New Learner",
	target_language: "en",
};

function dbWithInsertSuccess() {
	return makeFakeDb([
		{
			match: "INSERT INTO users",
			rows: [
				{
					id: NEW_USER_ID,
					email: VALID_BODY.email,
					display_name: VALID_BODY.display_name,
					role: "learner",
					subscription_tier: "free",
				},
			],
		},
		{
			match: "INSERT INTO learner_profiles",
			rows: [{ id: NEW_PROFILE_ID, target_language: "en", target_exam: null }],
		},
	]);
}

describe("POST /api/v1/auth/register", () => {
	it("creates the user and profile in one transaction, returns 201 with an access token and sets the refresh cookie", async () => {
		const db = dbWithInsertSuccess();
		const { app, redis } = await buildTestApp({ db });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: VALID_BODY,
		});

		expect(res.statusCode).toBe(201);
		const body = res.json();
		expect(body.user).toEqual({
			id: NEW_USER_ID,
			email: VALID_BODY.email,
			display_name: VALID_BODY.display_name,
			role: "learner",
			subscription_tier: "free",
			learner_profile_id: NEW_PROFILE_ID,
			target_language: "en",
			target_exam: null,
		});
		expect(typeof body.access_token).toBe("string");

		// Both inserts went through the same transaction() call, in order.
		const userInsert = db.calls.find((c) => c.text.includes("INSERT INTO users"));
		const profileInsert = db.calls.find((c) => c.text.includes("INSERT INTO learner_profiles"));
		expect(userInsert?.params?.[0]).toBe(VALID_BODY.email);
		expect(profileInsert?.params).toEqual([NEW_USER_ID, "en", null]);

		// Registered "live" in Redis for the configured TTL — what makes it revocable.
		expect(redis.store.size).toBe(1);
		const [[, storedUserId]] = redis.store;
		expect(storedUserId).toBe(NEW_USER_ID);
		const [[, ttl]] = redis.ttls;
		expect(ttl).toBe(REFRESH_TOKEN_TTL_SECONDS);
	});

	it("sets the refresh cookie httpOnly, sameSite=Strict, scoped to /api/v1/auth", async () => {
		const { app } = await buildTestApp({ db: dbWithInsertSuccess() });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: VALID_BODY,
		});

		const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
		expect(cookie).toBeDefined();
		expect(cookie?.httpOnly).toBe(true);
		expect(cookie?.sameSite).toBe("Strict");
		expect(cookie?.path).toBe(REFRESH_COOKIE_PATH);
		expect(cookie?.maxAge).toBe(REFRESH_TOKEN_TTL_SECONDS);
	});

	it("marks the refresh cookie secure in production but not otherwise", async () => {
		// Browsers drop a Secure cookie over plain HTTP — unconditional `true`
		// would break session restore in local dev on http://localhost.
		const originalEnv = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = "production";
			const prodApp = await buildTestApp({ db: dbWithInsertSuccess() });
			const prodRes = await prodApp.app.inject({
				method: "POST",
				url: "/api/v1/auth/register",
				payload: VALID_BODY,
			});
			expect(prodRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)?.secure).toBe(true);

			process.env.NODE_ENV = "development";
			const devApp = await buildTestApp({ db: dbWithInsertSuccess() });
			const devRes = await devApp.app.inject({
				method: "POST",
				url: "/api/v1/auth/register",
				payload: VALID_BODY,
			});
			// An absent Secure flag parses as undefined, not false — toBeFalsy covers both.
			expect(devRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)?.secure).toBeFalsy();
		} finally {
			process.env.NODE_ENV = originalEnv;
		}
	});

	it("issues an access token with a 15-minute lifetime and the right claims", async () => {
		const { app } = await buildTestApp({ db: dbWithInsertSuccess() });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: VALID_BODY,
		});
		const { access_token } = res.json();

		const claims = decodeJwt(access_token);
		expect(claims.sub).toBe(NEW_USER_ID);
		expect(claims.role).toBe("learner");
		expect(claims.tier).toBe("free");
		expect(claims.lpid).toBe(NEW_PROFILE_ID);
		expect(claims.token_use).toBe("access");
		expect((claims.exp as number) - (claims.iat as number)).toBe(15 * 60);
	});

	it("returns 409 EMAIL_TAKEN when the email is already registered", async () => {
		const db = makeFakeDb([
			{
				match: "INSERT INTO users",
				rows: [],
				throws: Object.assign(new Error("duplicate key value violates unique constraint"), {
					code: "23505",
				}),
			},
		]);
		const { app } = await buildTestApp({ db });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: VALID_BODY,
		});

		expect(res.statusCode).toBe(409);
		expect(res.json()).toEqual({
			error: {
				code: "EMAIL_TAKEN",
				message: "an account with this email already exists",
				field: "email",
			},
		});
	});

	it("rejects a password shorter than 8 characters", async () => {
		const { app } = await buildTestApp({ db: dbWithInsertSuccess() });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: { ...VALID_BODY, password: "short" },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("VALIDATION_ERROR");
		expect(res.json().error.field).toBe("password");
	});

	it("rejects an invalid email", async () => {
		const { app } = await buildTestApp({ db: dbWithInsertSuccess() });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: { ...VALID_BODY, email: "not-an-email" },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("VALIDATION_ERROR");
		expect(res.json().error.field).toBe("email");
	});

	it("lowercases the email before it reaches the insert", async () => {
		// Otherwise "Frank@Example.com" registers alongside "frank@example.com":
		// the unique constraint compares case-sensitively and lets both through.
		const db = dbWithInsertSuccess();
		const { app } = await buildTestApp({ db });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: { ...VALID_BODY, email: "  New.Learner@Example.COM " },
		});

		expect(res.statusCode).toBe(201);
		const userInsert = db.calls.find((c) => c.text.includes("INSERT INTO users"));
		expect(userInsert?.params?.[0]).toBe("new.learner@example.com");
	});

	it("rejects a target_language outside the Phase 1 scope (en, fr)", async () => {
		const { app } = await buildTestApp({ db: dbWithInsertSuccess() });

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/register",
			payload: { ...VALID_BODY, target_language: "es" },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("VALIDATION_ERROR");
	});
});
