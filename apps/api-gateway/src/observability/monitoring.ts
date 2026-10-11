import { PRIVATE_DATA_COLLECTION, scrubErrorEvent } from "@lingumentor/shared-schemas";
import * as Sentry from "@sentry/node";

import { SERVICE_NAME } from "./logger";

/** Starts error reporting to Bugsink when SENTRY_DSN is set; without it every report is a no-op. */
export function initMonitoring(transport?: Sentry.NodeOptions["transport"]): void {
	const dsn = process.env.SENTRY_DSN;
	if (!dsn) return;
	Sentry.init({
		dsn,
		environment: process.env.SENTRY_ENVIRONMENT || "development",
		release: process.env.SENTRY_RELEASE || undefined,
		serverName: SERVICE_NAME,
		initialScope: { tags: { service: SERVICE_NAME } },
		// Its automatic capture has no request id, and dedupe would then drop ours; the error handler reports 500s.
		integrations: (defaults) => defaults.filter((integration) => integration.name !== "Fastify"),
		dataCollection: PRIVATE_DATA_COLLECTION,
		beforeSend: scrubErrorEvent,
		...(transport ? { transport } : {}),
	});
}

/** Reports an error the API answered with a 500. Tags are per call, so concurrent requests never share them. */
export function reportError(err: unknown, requestId: string): void {
	Sentry.captureException(err, { tags: { requestId, service: SERVICE_NAME } });
}

export async function flushMonitoring(): Promise<void> {
	await Sentry.flush(2000);
}
