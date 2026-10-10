// Typed env var loader — validate on boot, fail fast if anything required is missing.
import process from "process";

export interface Env {
	port: number;
	redisUrl: string;
	databaseUrl: string;
	jwtPrivateKeyPath: string;
	jwtPublicKeyPath: string;
	enforceCalibrationGate: boolean;
	aiServiceUrl: string;
	// Explicit by necessity: CORS rejects "*" once credentials are involved.
	corsOrigins: string[];
	// The web project's DSN in Bugsink, where browser error reports are relayed. Unset drops them.
	sentryWebDsn?: string;
}

export function loadEnv(): Env {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required (Neon connection string — see .env.example)");
	}
	const jwtPrivateKeyPath = process.env.JWT_PRIVATE_KEY_PATH;
	const jwtPublicKeyPath = process.env.JWT_PUBLIC_KEY_PATH;
	if (!jwtPrivateKeyPath || !jwtPublicKeyPath) {
		throw new Error(
			"JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH are required — run scripts/generate-jwt-keys.sh",
		);
	}
	return {
		port: Number(process.env.PORT || 3000),
		redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
		databaseUrl,
		jwtPrivateKeyPath,
		jwtPublicKeyPath,
		// Phase 0 gate (Calibration Brief §9): withhold bands scored without an
		// active baseline. Fail-closed; dev sets =false for provisional scores.
		enforceCalibrationGate: process.env.ENFORCE_CALIBRATION_GATE !== "false",
		// Same var the worker uses; :8000 is the ai-service container's port.
		aiServiceUrl: process.env.AI_SERVICE_URL || "http://localhost:8000",
		// Default is the frontend's dev port (next dev -p 3001); prod sets it.
		corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:3001")
			.split(",")
			.map((o) => o.trim())
			.filter(Boolean),
		sentryWebDsn: process.env.SENTRY_WEB_DSN || undefined,
	};
}
