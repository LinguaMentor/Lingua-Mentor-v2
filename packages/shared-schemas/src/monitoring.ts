// Essays, chat text and personal data never reach the error tracker: the SDKs collect nothing, and the scrubber is the backstop.

/** Sentry's `dataCollection` option with every category switched off. Version 11 collects all of them by default. */
export const PRIVATE_DATA_COLLECTION = {
	userInfo: false,
	cookies: false,
	httpHeaders: false,
	httpBodies: [] as never[],
	urlQueryParams: false,
	databaseQueryData: false,
	queues: false,
	stackFrameVariables: false,
	graphQL: { document: false, variables: false },
	genAI: { inputs: false, outputs: false },
} as const;

// The parts of a Sentry event that can carry request or user data, typed loosely so this package needs no SDK.
interface ScrubbableEvent {
	request?: {
		url?: string;
		data?: unknown;
		cookies?: unknown;
		headers?: unknown;
		query_string?: unknown;
		env?: unknown;
	};
	user?: unknown;
	extra?: unknown;
	exception?: { values?: { stacktrace?: { frames?: { vars?: unknown }[] } }[] };
	breadcrumbs?: { data?: Record<string, unknown> }[];
}

// A query string or fragment can hold a reset token or an email; the path is enough to find the bug.
function withoutQuery(url: string): string {
	return url.replace(/[?#].*$/, "");
}

/** Removes request bodies, cookies, headers, query strings, user fields, extras and frame variables. */
export function scrubErrorEvent<T extends ScrubbableEvent>(event: T): T {
	if (event.request) {
		const { url } = event.request;
		event.request = url ? { url: withoutQuery(url) } : {};
	}
	delete event.user;
	delete event.extra;
	for (const exception of event.exception?.values ?? []) {
		for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
	}
	for (const breadcrumb of event.breadcrumbs ?? []) {
		const data = breadcrumb.data;
		if (!data) continue;
		for (const key of ["url", "from", "to"]) {
			if (typeof data[key] === "string") data[key] = withoutQuery(data[key] as string);
		}
	}
	return event;
}
