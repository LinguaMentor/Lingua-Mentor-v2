# Build context is the REPO ROOT — frontend depends on the workspace
# package @lingumentor/shared-schemas, same reason as api-gateway.
#
# Node 24-slim stays in lockstep with .nvmrc, root package.json engines,
# and the api-gateway image.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
# Isolated pnpm links break Next's standalone copy into the runtime stage.
ENV HUSKY=0
RUN printf 'node-linker=hoisted\n' > .npmrc

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-schemas/package.json packages/shared-schemas/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN pnpm install --frozen-lockfile --filter frontend...

COPY packages/shared-schemas packages/shared-schemas
COPY apps/frontend apps/frontend
# COPY of a missing public/ fails; Next still expects the directory at runtime.
RUN mkdir -p apps/frontend/public
RUN pnpm --filter @lingumentor/shared-schemas build

# Inlined at `next build`. The browser uses these, so they must be a host
# address (localhost in the local stack), never a Compose service name.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
ARG NEXT_PUBLIC_WS_VOICE_URL=ws://localhost:3000/voice
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
	NEXT_PUBLIC_WS_VOICE_URL=$NEXT_PUBLIC_WS_VOICE_URL \
	NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter frontend build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
	PORT=3000 \
	HOSTNAME=0.0.0.0 \
	NEXT_TELEMETRY_DISABLED=1

# Standalone omits public/ and .next/static (CDN-oriented). Copy them next
# to server.js, which nests under apps/frontend in this monorepo.
COPY --from=build --chown=node:node /repo/apps/frontend/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=build --chown=node:node /repo/apps/frontend/public ./apps/frontend/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD node -e "require('http').get('http://localhost:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/frontend/server.js"]
