// Base HTTP layer for every api-gateway call: apiFetch (no auth) and
// authenticatedFetch (bearer token + one silent refresh on 401).
//
// Both send `credentials: "include"` on every request, not just /auth/refresh —
// the browser only keeps the refresh cookie alive if it travels.
import type { AuthSession, ErrorEnvelope } from "@/lib/api/types";
import { useAuthStore } from "@/store/auth-store";

// Empty means the origin the page loaded from, so one image serves every environment.
const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "";

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		public readonly field?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function parseError(res: Response): Promise<ApiError> {
	try {
		const body = (await res.json()) as ErrorEnvelope;
		return new ApiError(res.status, body.error.code, body.error.message, body.error.field);
	} catch {
		return new ApiError(res.status, "UNKNOWN_ERROR", `Request failed with status ${res.status}`);
	}
}

/** Low-level JSON fetch — no auth header, no retry, throws ApiError on any
 * non-2xx response. `path` is relative to the gateway's base URL. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${BASE_URL}${path}`, {
			...init,
			credentials: "include",
			headers: {
				// Conditional: Fastify rejects a JSON content-type with an empty
				// body, which is what /auth/refresh and /auth/logout would send.
				...(init.body != null ? { "content-type": "application/json" } : {}),
				...(init.headers ?? {}),
			},
		});
	} catch {
		// DNS/connection/CORS: the gateway is unreachable, not a caller mistake.
		throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Check your connection.");
	}

	if (res.status === 204) return undefined as T;
	if (!res.ok) throw await parseError(res);
	return (await res.json()) as T;
}

let refreshInFlight: Promise<AuthSession> | null = null;

// Backs off 600ms then 1200ms, sized to absorb a Neon scale-to-zero cold
// start (ADR 0001 §3.2) — the documented steady state, not an incident.
const REFRESH_TRANSIENT_RETRIES = 2;
const REFRESH_RETRY_BASE_MS = 600;

/** Whether a failed refresh says anything about the session's validity: a 401
 * is a final answer, a 5xx/network error is no answer at all. */
function isTransientRefreshFailure(err: unknown): boolean {
	return err instanceof ApiError && (err.status === 0 || err.status >= 500);
}

async function refreshWithRetry(): Promise<AuthSession> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await apiFetch<AuthSession>("/api/v1/auth/refresh", { method: "POST" });
		} catch (err) {
			// A 401 never retries — the token is single-use, so it cannot succeed.
			if (!isTransientRefreshFailure(err) || attempt >= REFRESH_TRANSIENT_RETRIES) throw err;
			await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_BASE_MS * 2 ** attempt));
		}
	}
}

/** The only way to refresh: never POST /auth/refresh directly. The token is
 * single-use, so concurrent callers share one in-flight attempt (dedupe spans
 * the backoff above) rather than rotating it out from under each other. */
export function refreshSession(): Promise<AuthSession> {
	if (!refreshInFlight) {
		refreshInFlight = refreshWithRetry().finally(() => {
			refreshInFlight = null;
		});
	}
	return refreshInFlight;
}

/** The entry point for every authenticated call: bearer token, then one silent
 * refresh + retry on a 401. Redirecting to login is the route guard's job. */
export async function authenticatedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
	const withToken = (token: string | null): RequestInit => ({
		...init,
		headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
	});

	const token = useAuthStore.getState().accessToken;
	try {
		return await apiFetch<T>(path, withToken(token));
	} catch (err) {
		if (!(err instanceof ApiError) || err.status !== 401) throw err;

		try {
			const session = await refreshSession();
			useAuthStore.getState().setSession(session.access_token, session.user);
			return await apiFetch<T>(path, withToken(session.access_token));
		} catch (refreshErr) {
			// Only tear down when the refresh proved there's no session. The access
			// token is memory-only, so a wrong eviction here costs a full re-login.
			if (!isTransientRefreshFailure(refreshErr)) {
				useAuthStore.getState().clearSession();
			}
			throw err; // surface the original 401, not the refresh failure
		}
	}
}
