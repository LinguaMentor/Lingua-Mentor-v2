import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const REQUEST_ID_HEADER = "x-request-id";

// Long enough for a UUID or a trace id, and nothing that could break a log line or a header.
const VALID_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** Fastify's genReqId: the caller's id when it is valid, a new one otherwise. */
export function requestIdFor(req: IncomingMessage): string {
	const incoming = req.headers[REQUEST_ID_HEADER];
	return typeof incoming === "string" && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function runWithRequestId(requestId: string, fn: () => void): void {
	requestContext.run({ requestId }, fn);
}

/** The id of the request being handled, for job payloads and calls to ai-service; undefined outside a request. */
export function currentRequestId(): string | undefined {
	return requestContext.getStore()?.requestId;
}
