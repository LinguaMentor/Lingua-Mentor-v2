# frontend

Next.js 16 PWA. App Router, route groups `(auth)` and `(dashboard)` split
authenticated vs public routes without affecting the URL path.

## Docker build

The Dockerfile's build context is the **repo root**, not this directory —
the app depends on `@lingumentor/shared-schemas`. Build with
`docker build -f apps/frontend/Dockerfile .` from the repo root (or
`docker compose -f infra/docker-compose.yml up web`).

`output: "standalone"` traces a minimal Node server. `public/` and
`.next/static` are copied into the image next to it; Next does not include
them on its own. The process listens on port 3000 as the `node` user.

`NEXT_PUBLIC_*` values are inlined at build time. Leave them empty and the
browser calls the API on the origin the page loaded from, by relative path:
that is how the staging and production image is built, so one image serves
every environment. Only the local stack sets them, to a URL the browser can
reach (`http://localhost:3000`), never a Compose service name.

## Error reports

Browser errors are posted to the API's `/api/v1/monitoring/envelope`, which relays them to Bugsink's web project. The bundle carries a placeholder DSN, never a real key or address, and the environment comes from the page's host (`staging.` is staging, `localhost` is development, anything else production). The release is the commit, passed as the `SENTRY_RELEASE` build argument. Render errors are reported from `app/global-error.tsx`, because Next catches them before the browser's own handler sees them.

On the server, `instrumentation.ts` reports errors when `SENTRY_DSN` is set. Both sides collect no request data, user fields or local variables (`lib/monitoring.ts`).

To check it on a deployed page, run `setTimeout(() => { throw new Error("browser test error") })` in the browser console.
