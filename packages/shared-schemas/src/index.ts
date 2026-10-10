// zod schemas shared between the frontend and api-gateway for
// request/response validation. Anything only one app cares about (route
// params, header parsing) stays local to that app instead of landing here —
// see docs/architecture/project-structure-and-conventions.md §1.
export * from "./auth";
export * from "./monitoring";
export * from "./writing";
