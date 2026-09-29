// JWT-verify preHandler + RBAC guard. Attached per-route-plugin, not globally,
// so /health and /api/v1/auth/* stay reachable without a token.
import type { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "../plugins/error-envelope";
import { TokenExpiredError } from "../modules/auth/jwt.strategy";

export interface AuthenticatedUser {
	userId: string;
	role: string;
	tier: string;
	learnerProfileId: string;
}

declare module "fastify" {
	interface FastifyRequest {
		user?: AuthenticatedUser;
	}
}

function extractBearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, token] = header.split(" ");
	if (scheme !== "Bearer" || !token) return null;
	return token;
}

export async function authenticate(request: FastifyRequest): Promise<void> {
	const token = extractBearerToken(request.headers.authorization);
	if (!token) {
		throw new AppError(401, "UNAUTHORIZED", "missing bearer token");
	}

	try {
		const claims = await request.server.jwt.verifyAccessToken(token);
		request.user = {
			userId: claims.sub,
			role: claims.role,
			tier: claims.tier,
			learnerProfileId: claims.lpid,
		};
	} catch (err) {
		if (err instanceof TokenExpiredError) {
			throw new AppError(401, "TOKEN_EXPIRED", "access token has expired");
		}
		throw new AppError(401, "UNAUTHORIZED", "invalid access token");
	}
}

/** Route guard for role-restricted endpoints — must run after `authenticate`. */
export function requireRole(...roles: string[]) {
	return async function requireRoleHook(
		request: FastifyRequest,
		_reply: FastifyReply,
	): Promise<void> {
		if (!request.user || !roles.includes(request.user.role)) {
			throw new AppError(403, "FORBIDDEN", "you do not have permission to perform this action");
		}
	};
}
