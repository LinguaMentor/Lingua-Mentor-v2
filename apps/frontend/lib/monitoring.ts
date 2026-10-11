import { PRIVATE_DATA_COLLECTION, scrubErrorEvent } from "@lingumentor/shared-schemas";

import { API_BASE_URL } from "@/lib/api/base-url";

// The gateway relays browser reports with the web project's real DSN, so the bundle carries no key or address.
const RELAYED_DSN = "https://browser@relay.invalid/0";

/** One image serves every environment, so the browser tells them apart by the page's host. */
export function environmentFor(hostname: string): string {
	if (hostname === "localhost" || hostname === "127.0.0.1") return "development";
	if (hostname.startsWith("staging.")) return "staging";
	return "production";
}

/** Sentry options for the browser: reports go to our own API, scrubbed, never to a third-party host. */
export function browserMonitoringOptions(hostname: string) {
	return {
		dsn: RELAYED_DSN,
		tunnel: `${API_BASE_URL}/api/v1/monitoring/envelope`,
		environment: environmentFor(hostname),
		release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
		initialScope: { tags: { service: "web" } },
		dataCollection: PRIVATE_DATA_COLLECTION,
		beforeSend: scrubErrorEvent,
	};
}
