// Browser error reports, relayed to Bugsink. Same origin as the app, so ad blockers leave them alone.
import type { FastifyInstance } from "fastify";

export interface MonitoringRoutesOptions {
	// The web project's DSN. Every envelope goes there, whatever DSN the browser put in it, so this is never an open relay.
	webDsn?: string;
}

const NEWLINE = 0x0a;
const RELAY_TIMEOUT_MS = 5000;
// Browser reports are a few KB; anyone can post here, so a large body is refused instead of forwarded.
const MAX_ENVELOPE_BYTES = 256 * 1024;

function parseDsn(dsn: string) {
	const url = new URL(dsn);
	return {
		origin: url.origin,
		publicKey: url.username,
		projectId: url.pathname.replace(/^\/+|\/+$/g, ""),
	};
}

export default async function monitoringRoutes(
	app: FastifyInstance,
	opts: MonitoringRoutesOptions,
): Promise<void> {
	const target = opts.webDsn ? { dsn: opts.webDsn, ...parseDsn(opts.webDsn) } : undefined;

	// The SDK posts envelopes as text/plain to avoid a CORS preflight; they are relayed as bytes, never parsed whole.
	app.removeAllContentTypeParsers();
	app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

	app.post("/envelope", { bodyLimit: MAX_ENVELOPE_BYTES }, async (request, reply) => {
		// No web project configured (local development): accept and drop.
		if (!target) return reply.status(204).send();

		const body = request.body as Buffer;
		const end = body.indexOf(NEWLINE);
		let header: Record<string, unknown>;
		try {
			header = JSON.parse(body.subarray(0, end === -1 ? body.length : end).toString("utf8"));
		} catch {
			return reply.status(400).send();
		}
		header.dsn = target.dsn;
		const envelope = Buffer.concat([
			Buffer.from(JSON.stringify(header)),
			end === -1 ? Buffer.alloc(0) : body.subarray(end),
		]);

		try {
			const res = await fetch(`${target.origin}/api/${target.projectId}/envelope/`, {
				method: "POST",
				headers: {
					"content-type": "application/x-sentry-envelope",
					"x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.publicKey}`,
				},
				body: envelope,
				signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
			});
			return reply.status(res.status).send();
		} catch (err) {
			request.log.warn({ err }, "could not relay a browser error report");
			return reply.status(502).send();
		}
	});
}
