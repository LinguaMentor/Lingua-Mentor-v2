// `node dist/observability/send-test-error.js` sends one test error with this container's settings.
import * as Sentry from "@sentry/node";

import { SERVICE_NAME } from "./logger";
import { flushMonitoring, initMonitoring } from "./monitoring";

if (!process.env.SENTRY_DSN) {
	console.log("SENTRY_DSN is not set, nothing was sent");
} else {
	initMonitoring();
	console.log(Sentry.captureException(new Error(`Test error from ${SERVICE_NAME}`)));
	void flushMonitoring();
}
