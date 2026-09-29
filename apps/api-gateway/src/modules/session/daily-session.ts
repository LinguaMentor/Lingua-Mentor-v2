// Daily micro-session read path (PRD §35.3). Generation lives in ai-service.
import { SRS_DAILY_KEY_PREFIX } from "../../config/constants";
import type { AiServiceClient, DailySessionDto } from "../../clients/ai-service";
import type { RedisKv } from "../../redis/client";

export interface DailySessionDeps {
	aiService: AiServiceClient;
	redis: RedisKv;
}

const SECONDS_PER_DAY = 86_400;

export function utcDateString(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/** §33's flat 24h would serve a 02:00 session at 00:30 the next day, under a key
 * with no date in it. Expiring on the boundary is what makes the key mean today. */
export function secondsUntilUtcMidnight(now = new Date()): number {
	const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	const remaining = Math.ceil((midnight - now.getTime()) / 1000);
	return Math.min(Math.max(remaining, 1), SECONDS_PER_DAY);
}

async function readCache(
	deps: DailySessionDeps,
	key: string,
	today: string,
): Promise<DailySessionDto | null> {
	try {
		const cached = await deps.redis.get(key);
		if (!cached) return null;
		const parsed = JSON.parse(cached) as DailySessionDto;
		// Correctness can't rest on Redis expiring on time.
		return parsed.session_date === today ? parsed : null;
	} catch {
		return null;
	}
}

export async function getDailySession(
	deps: DailySessionDeps,
	learnerProfileId: string,
): Promise<DailySessionDto> {
	const key = `${SRS_DAILY_KEY_PREFIX}${learnerProfileId}`;
	const today = utcDateString();

	const cached = await readCache(deps, key, today);
	if (cached) return cached;

	// §35.3 is "trigger or retrieve" — a miss generates rather than 404s.
	const session = await deps.aiService.generateDailySession(learnerProfileId);

	try {
		await deps.redis.setex(key, secondsUntilUtcMidnight(), JSON.stringify(session));
	} catch {
		// Redis down costs the next read a regeneration, not this one its answer.
	}
	return session;
}
