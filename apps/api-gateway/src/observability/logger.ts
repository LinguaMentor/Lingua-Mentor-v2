import type { FastifyServerOptions } from "fastify";

export const SERVICE_NAME = "api-gateway";

// Only the shape of an error: a driver's `detail` can quote the row it failed on, email or essay included.
function serializeError(err: Error & { code?: unknown }) {
	return {
		type: err.name,
		message: err.message,
		stack: err.stack ?? "",
		...(typeof err.code === "string" ? { code: err.code } : {}),
	};
}

/** pino settings for one JSON shape across the services: time, level, service, requestId, msg. */
export function loggerOptions(stream?: {
	write(line: string): void;
}): FastifyServerOptions["logger"] {
	return {
		level: "info",
		base: { service: SERVICE_NAME },
		timestamp: () => `,"time":"${new Date().toISOString()}"`,
		formatters: { level: (label: string) => ({ level: label }) },
		serializers: { err: serializeError },
		...(stream ? { stream } : {}),
	};
}
