import path from "node:path";

import { defineConfig } from "vitest/config";

// "node" environment: the suite is pure-function/schema tests, no DOM yet. The
// "@/*" alias mirrors tsconfig so specs import app code the way the app does.
export default defineConfig({
	test: {
		environment: "node",
		coverage: {
			provider: "v8",
			// All app code, so files no test imports show up at 0% instead of being left out.
			include: ["{app,components,hooks,lib,store}/**/*.{ts,tsx}"],
			reporter: ["text-summary", "html"],
			reportsDirectory: "coverage",
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
		},
	},
});
