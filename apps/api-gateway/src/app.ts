import { readFileSync } from "node:fs";

import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import Fastify, { type FastifyInstance, LogController } from "fastify";

import { type AiServiceClient, createAiServiceClient } from "./clients/ai-service";
import { loadEnv } from "./config/env";
import { createPool, type DbClient } from "./db/client";
import authRoutes from "./modules/auth/auth.routes";
import { JwtStrategy } from "./modules/auth/jwt.strategy";
import monitoringRoutes from "./modules/monitoring/monitoring.routes";
import placementRoutes from "./modules/placement/placement.routes";
import sessionRoutes from "./modules/session/session.routes";
import voiceRoutes from "./modules/voice/voice.routes";
import usersRoutes from "./modules/users/users.routes";
import writingRoutes, { writingPublicRoutes } from "./modules/writing/writing.routes";
import { loggerOptions } from "./observability/logger";
import { REQUEST_ID_HEADER, requestIdFor, runWithRequestId } from "./observability/request-context";
import { registerErrorEnvelope } from "./plugins/error-envelope";
import {
	type AppealEvalQueue,
	createAppealEvalQueue,
	createSrsBatchQueue,
	createWritingEvalQueue,
	scheduleSrsBatch,
	type SrsBatchQueue,
	type WritingEvalQueue,
} from "./queue/bullmq-client";
import { createRedisKv, type RedisKv } from "./redis/client";

declare module "fastify" {
	interface FastifyInstance {
		db: DbClient;
		writingQueue: WritingEvalQueue;
		appealQueue: AppealEvalQueue;
		redis: RedisKv;
		jwt: JwtStrategy;
		calibrationGateEnforced: boolean;
		aiService: AiServiceClient;
		srsBatchQueue?: SrsBatchQueue;
	}
}

export interface AppOptions {
	// Test seams — production wiring is the default for anything omitted.
	db?: DbClient;
	queue?: WritingEvalQueue;
	appealQueue?: AppealEvalQueue;
	redis?: RedisKv;
	jwt?: JwtStrategy;
	enforceCalibrationGate?: boolean;
	aiService?: AiServiceClient;
	corsOrigins?: string[];
	srsBatchQueue?: SrsBatchQueue;
	webErrorsDsn?: string;
	logStream?: { write(line: string): void };
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
	const app = Fastify({
		logger: loggerOptions(opts.logStream),
		genReqId: requestIdFor,
		logController: new LogController({ requestIdLogLabel: "requestId" }),
	});

	// Returned on every response, errors included, so a report from a learner can be matched to the logs.
	app.addHook("onRequest", async (request, reply) => {
		reply.header(REQUEST_ID_HEADER, request.id);
	});
	// After the body is parsed, so the handler and everything it awaits can read the id (see request-context.ts).
	app.addHook("preValidation", (request, _reply, done) => runWithRequestId(request.id, done));

	// Direct call, not app.register — Fastify v5 would scope it to the plugin.
	registerErrorEnvelope(app);

	// This API only ever emits JSON, so nothing should render, frame or embed it.
	app.register(fastifyHelmet, {
		contentSecurityPolicy: {
			useDefaults: false,
			directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"] },
		},
	});

	// At root, ahead of every route plugin that reads or sets a cookie.
	app.register(fastifyCookie);

	let db = opts.db;
	let queue = opts.queue;
	let appealQueue = opts.appealQueue;
	let redis = opts.redis;
	let jwt = opts.jwt;
	let enforceCalibrationGate = opts.enforceCalibrationGate;
	let aiService = opts.aiService;
	let corsOrigins = opts.corsOrigins;
	let srsBatchQueue = opts.srsBatchQueue;
	let webErrorsDsn = opts.webErrorsDsn;
	if (!db || !queue || !appealQueue || !redis || !jwt || !aiService || !corsOrigins) {
		const env = loadEnv();
		db = db ?? createPool(env.databaseUrl);
		queue = queue ?? createWritingEvalQueue(env.redisUrl);
		appealQueue = appealQueue ?? createAppealEvalQueue(env.redisUrl);
		redis = redis ?? createRedisKv(env.redisUrl);
		jwt =
			jwt ??
			new JwtStrategy(
				readFileSync(env.jwtPrivateKeyPath, "utf-8"),
				readFileSync(env.jwtPublicKeyPath, "utf-8"),
			);
		enforceCalibrationGate = enforceCalibrationGate ?? env.enforceCalibrationGate;
		aiService = aiService ?? createAiServiceClient(env.aiServiceUrl);
		corsOrigins = corsOrigins ?? env.corsOrigins;
		srsBatchQueue = srsBatchQueue ?? createSrsBatchQueue(env.redisUrl);
		webErrorsDsn = webErrorsDsn ?? env.sentryWebDsn;
	}

	// The refresh cookie is cross-origin, so credentials must be on — and once
	// they are, browsers require an explicit allowlist rather than "*".
	app.register(fastifyCors, { origin: corsOrigins, credentials: true });

	app.decorate("db", db);
	app.decorate("writingQueue", queue);
	app.decorate("appealQueue", appealQueue);
	app.decorate("redis", redis);
	app.decorate("jwt", jwt);
	app.decorate("aiService", aiService);
	app.decorate("srsBatchQueue", srsBatchQueue);
	// Fail-closed — nothing set it means the gate is on (see loadEnv).
	app.decorate("calibrationGateEnforced", enforceCalibrationGate ?? true);

	// Upsert is idempotent by id, so every replica doing this on boot is fine.
	// A failure must not stop the API serving — the batch is an optimisation.
	app.addHook("onReady", async () => {
		if (!app.srsBatchQueue) return;
		try {
			await scheduleSrsBatch(app.srsBatchQueue);
		} catch (err) {
			app.log.error({ err }, "could not register the daily-session batch schedule");
		}
	});

	app.addHook("onClose", async () => {
		await app.writingQueue.close?.();
		await app.appealQueue.close?.();
		await app.srsBatchQueue?.close?.();
		await app.redis.quit?.();
		await app.db.end?.();
	});

	// Liveness. `/health` is for the container check; the tunnel only routes /api/, so the uptime check uses the other.
	const liveness = async () => ({ status: "ok", uptime: process.uptime() });
	app.get("/health", { logLevel: "warn" }, liveness);
	app.get("/api/v1/health", { logLevel: "warn" }, liveness);

	app.register(authRoutes, { prefix: "/api/v1/auth" });
	app.register(usersRoutes, { prefix: "/api/v1/user" });
	app.register(writingPublicRoutes, { prefix: "/api/v1/writing" });
	app.register(writingRoutes, { prefix: "/api/v1/writing" });
	app.register(placementRoutes, { prefix: "/api/v1/placement" });
	app.register(sessionRoutes, { prefix: "/api/v1/session" });
	app.register(voiceRoutes, { prefix: "/api/v1/voice" });
	app.register(monitoringRoutes, { prefix: "/api/v1/monitoring", webDsn: webErrorsDsn });

	return app;
}
