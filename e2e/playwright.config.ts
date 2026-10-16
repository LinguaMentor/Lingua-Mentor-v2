import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	forbidOnly: Boolean(process.env.CI),
	// A journey that only passes on a second try is a bug to fix, not to hide.
	retries: 0,
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
	use: {
		// localhost, not 127.0.0.1: the gateway's CORS allows the web app's origin by name.
		baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
