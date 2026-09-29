// Session & adaptive endpoints (PRD §35.3) — registered under /api/v1/session.
import type { FastifyInstance } from "fastify";

import { authenticate } from "../../middleware/authenticate";
import { getDailySession } from "./daily-session";
import { lessonStartSchema, lessonMessageSchema, lessonIdParamSchema } from "./session.schema";
import { startLesson, streamLessonChat } from "./lesson.service";
import { getSrsSchedule } from "./session.service";

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
	// Scoped to this plugin only — see src/middleware/authenticate.ts.
	app.addHook("preHandler", authenticate);

	app.post("/daily-diagnostic", async (request) => {
		return getDailySession(
			{ aiService: app.aiService, redis: app.redis },
			request.user!.learnerProfileId,
		);
	});

	app.post("/lesson", async (request, reply) => {
		const body = lessonStartSchema.parse(request.body ?? {});
		return reply
			.status(201)
			.send(
				await startLesson({ aiService: app.aiService }, request.user!.learnerProfileId, body.topic),
			);
	});

	// SSE (PRD §19.5): a POST, not EventSource — the browser can't put a bearer
	// token on an EventSource, and a token in the query string lands in logs.
	app.post("/lesson/:lesson_session_id/message", async (request, reply) => {
		const { lesson_session_id } = lessonIdParamSchema.parse(request.params);
		const body = lessonMessageSchema.parse(request.body);

		const stream = await streamLessonChat(
			{ aiService: app.aiService },
			request.user!.learnerProfileId,
			lesson_session_id,
			body.message,
		);

		reply.raw.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});

		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				reply.raw.write(value);
			}
		} catch (err) {
			request.log.error({ err }, "lesson chat stream broke mid-flight");
		} finally {
			reader.releaseLock();
			reply.raw.end();
		}
		return reply;
	});

	app.get("/srs-schedule", async (request) => {
		return getSrsSchedule(
			{ aiService: app.aiService, redis: app.redis },
			request.user!.learnerProfileId,
		);
	});
}
