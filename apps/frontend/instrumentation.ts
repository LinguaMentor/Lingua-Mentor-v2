import * as Sentry from "@sentry/nextjs";

export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.SENTRY_DSN) return;
	const { PRIVATE_DATA_COLLECTION, scrubErrorEvent } = await import("@lingumentor/shared-schemas");
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		environment: process.env.SENTRY_ENVIRONMENT || "development",
		release: process.env.SENTRY_RELEASE || undefined,
		initialScope: { tags: { service: "web-server" } },
		dataCollection: PRIVATE_DATA_COLLECTION,
		beforeSend: scrubErrorEvent,
	});
}

// Errors thrown while rendering or in route handlers on the server.
export const onRequestError = Sentry.captureRequestError;
