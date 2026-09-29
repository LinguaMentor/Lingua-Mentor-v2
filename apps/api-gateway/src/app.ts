import { readFileSync } from "node:fs";

import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";

import { type AiServiceClient, createAiServiceClient } from "./clients/ai-service";
import { loadEnv } from "./config/env";
import { createPool, type DbClient } from "./db/client";
import authRoutes from "./modules/auth/auth.routes";
import { JwtStrategy } from "./modules/auth/jwt.strategy";
import placementRoutes from "./modules/placement/placement.routes";
import sessionRoutes from "./modules/session/session.routes";
import voiceRoutes from "./modules/voice/voice.routes";
import usersRoutes from "./modules/users/users.routes";
import writingRoutes, { writingPublicRoutes } from "./modules/writing/writing.routes";
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
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
	const app = Fastify({ logger: true });

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

	// Basic health endpoint used by the frontend and infra checks
	app.get("/health", async (_request, _reply) => {
		return { status: "ok", uptime: process.uptime() };
	});

	app.register(authRoutes, { prefix: "/api/v1/auth" });
	app.register(usersRoutes, { prefix: "/api/v1/user" });
	app.register(writingPublicRoutes, { prefix: "/api/v1/writing" });
	app.register(writingRoutes, { prefix: "/api/v1/writing" });
	app.register(placementRoutes, { prefix: "/api/v1/placement" });
	app.register(sessionRoutes, { prefix: "/api/v1/session" });
	app.register(voiceRoutes, { prefix: "/api/v1/voice" });

	return app;
}
