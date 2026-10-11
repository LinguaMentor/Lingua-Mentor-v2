// Global error envelope (Master PRD §34.1): {"error": {code, message, field?}}
// on every route, mirrored by ai-service's app/core/errors.py.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodIssue } from "zod";

import { reportError } from "../observability/monitoring";

export class AppError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly code: string,
		message: string,
		public readonly field?: string,
	) {
		super(message);
		this.name = "AppError";
	}
}

interface ErrorEnvelope {
	error: { code: string; message: string; field?: string };
}

function envelope(code: string, message: string, field?: string): ErrorEnvelope {
	return { error: { code, message, ...(field ? { field } : {}) } };
}

/** Structural, not `instanceof`: the workspace package boundary and Vitest's
 * module graph can each load zod twice, which breaks the class reference. */
function isZodError(err: unknown): err is { name: "ZodError"; issues: ZodIssue[] } {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: unknown }).name === "ZodError" &&
		Array.isArray((err as { issues?: unknown }).issues)
	);
}

/** A Fastify error that blames the request: an `FST_*` code plus its own 4xx.
 * Structural for the same reason as isZodError above. */
function isClientFastifyError(err: unknown): err is FastifyError & { statusCode: number } {
	if (typeof err !== "object" || err === null) return false;
	const { code, statusCode } = err as { code?: unknown; statusCode?: unknown };
	return (
		typeof code === "string" &&
		code.startsWith("FST_") &&
		typeof statusCode === "number" &&
		statusCode >= 400 &&
		statusCode < 500
	);
}

/** Called directly from buildApp, not via app.register — Fastify v5 scopes
 * error handlers to the registering plugin, and this must be global. */
export function registerErrorEnvelope(app: FastifyInstance): void {
	app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
		if (err instanceof AppError) {
			return reply.status(err.statusCode).send(envelope(err.code, err.message, err.field));
		}
		if (isZodError(err)) {
			const issue = err.issues[0];
			const field = issue?.path.join(".") || undefined;
			return reply
				.status(400)
				.send(envelope("VALIDATION_ERROR", issue?.message ?? "invalid request", field));
		}
		if (err instanceof Error && "validation" in err && (err as FastifyError).validation) {
			return reply.status(400).send(envelope("VALIDATION_ERROR", err.message));
		}
		// Malformed JSON, empty body, payload too large: already an accurate 4xx,
		// so don't let it reach the 500 below. 5xx FST_* codes do fall through.
		if (isClientFastifyError(err)) {
			return reply.status(err.statusCode).send(envelope(err.code, err.message));
		}
		// Unknown error: log the real thing, never leak internals to the client.
		request.log.error({ err }, "unhandled error");
		reportError(err, request.id);
		return reply.status(500).send(envelope("INTERNAL_ERROR", "internal server error"));
	});

	app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
		reply
			.status(404)
			.send(envelope("NOT_FOUND", `route ${request.method} ${request.url} not found`));
	});
}
