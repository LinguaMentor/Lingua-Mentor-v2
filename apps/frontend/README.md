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

`NEXT_PUBLIC_*` values are inlined at build time. They must be URLs the
browser can reach (for the local stack, `http://localhost:3000`), never a
Compose service name.
