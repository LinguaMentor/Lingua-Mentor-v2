import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			// All of src, so files no test imports show up at 0% instead of being left out.
			include: ["src/**/*.ts"],
			reporter: ["text-summary", "html"],
			reportsDirectory: "coverage",
		},
	},
});
