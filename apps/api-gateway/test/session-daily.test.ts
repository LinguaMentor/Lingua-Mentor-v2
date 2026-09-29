import { describe, expect, it } from "vitest";

import { SRS_DAILY_KEY_PREFIX } from "../src/config/constants";
import { secondsUntilUtcMidnight, utcDateString } from "../src/modules/session/daily-session";
import {
	DEFAULT_DAILY_SESSION,
	LEARNER_PROFILE_ID,
	bearerHeader,
	buildTestApp,
	makeFakeAiService,
	makeFakeRedis,
	signTestAccessToken,
} from "./helpers";

const DAILY_URL = "/api/v1/session/daily-diagnostic";
const CACHE_KEY = `${SRS_DAILY_KEY_PREFIX}${LEARNER_PROFILE_ID}`;

describe("secondsUntilUtcMidnight (ADR 0009 §2.6)", () => {
	it("expires on the day boundary, not 24h after the write", () => {
		// The bug a flat 24h TTL causes: a 02:00 session still cached at 00:30.
		const at2am = new Date("2026-07-17T02:00:00Z");

		expect(secondsUntilUtcMidnight(at2am)).toBe(22 * 3600);
	});

	it("never exceeds a day", () => {
		expect(secondsUntilUtcMidnight(new Date("2026-07-17T00:00:00Z"))).toBeLessThanOrEqual(86_400);
	});

	it("stays positive in the last second of the day", () => {
		expect(secondsUntilUtcMidnight(new Date("2026-07-17T23:59:59Z"))).toBeGreaterThan(0);
	});
});

describe("POST /api/v1/session/daily-diagnostic (PRD §35.3)", () => {
	it("generates today's session for the learner in the JWT", async () => {
		const aiService = makeFakeAiService();
		const { app, jwt } = await buildTestApp({ aiService });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: DAILY_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
		expect(res.json().skill_targeted).toBe("grammar");
		expect(aiService.calls).toEqual([{ method: "generateDailySession", args: LEARNER_PROFILE_ID }]);
	});

	it("caches under the §33 key with a TTL that ends at midnight", async () => {
		const redis = makeFakeRedis();
		const { app, jwt } = await buildTestApp({ redis });
		const token = await signTestAccessToken(jwt);

		await app.inject({ method: "POST", url: DAILY_URL, headers: bearerHeader(token) });

		expect(JSON.parse(redis.store.get(CACHE_KEY)!)).toEqual(DEFAULT_DAILY_SESSION);
		expect(redis.ttls.get(CACHE_KEY)).toBeLessThanOrEqual(86_400);
	});

	it("serves the cache instead of paying for a second generation", async () => {
		const redis = makeFakeRedis();
		const aiService = makeFakeAiService();
		const { app, jwt } = await buildTestApp({ redis, aiService });
		const token = await signTestAccessToken(jwt);

		await app.inject({ method: "POST", url: DAILY_URL, headers: bearerHeader(token) });
		await app.inject({ method: "POST", url: DAILY_URL, headers: bearerHeader(token) });

		// Each generation is a real LLM call (§55) — twice a day is twice the bill.
		expect(aiService.calls).toHaveLength(1);
	});

	it("ignores a cached session left over from a previous day", async () => {
		// Belt and braces against the TTL: the date in the value decides.
		const redis = makeFakeRedis();
		const aiService = makeFakeAiService();
		await redis.setex(
			CACHE_KEY,
			86_400,
			JSON.stringify({ ...DEFAULT_DAILY_SESSION, session_date: "2020-01-01" }),
		);
		const { app, jwt } = await buildTestApp({ redis, aiService });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: DAILY_URL, headers: bearerHeader(token) });

		expect(res.json().session_date).toBe(utcDateString());
		expect(aiService.calls).toHaveLength(1);
	});

	it("still answers when Redis is down", async () => {
		const redis = makeFakeRedis();
		redis.get = async () => {
			throw new Error("redis down");
		};
		redis.setex = async () => {
			throw new Error("redis down");
		};
		const { app, jwt } = await buildTestApp({ redis });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: DAILY_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(200);
	});

	it("surfaces a generation failure through the gateway envelope", async () => {
		const { AppError } = await import("../src/plugins/error-envelope");
		const aiService = makeFakeAiService({
			dailySessionError: new AppError(502, "EVALUATION_FAILED", "model failed"),
		});
		const { app, jwt } = await buildTestApp({ aiService });
		const token = await signTestAccessToken(jwt);

		const res = await app.inject({ method: "POST", url: DAILY_URL, headers: bearerHeader(token) });

		expect(res.statusCode).toBe(502);
	});

	it("rejects a request with no bearer token", async () => {
		const { app } = await buildTestApp();

		expect((await app.inject({ method: "POST", url: DAILY_URL })).statusCode).toBe(401);
	});
});
