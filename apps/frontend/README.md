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
