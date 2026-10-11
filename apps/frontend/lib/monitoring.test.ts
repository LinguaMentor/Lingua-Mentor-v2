import { describe, expect, it } from "vitest";

import { browserMonitoringOptions, environmentFor } from "@/lib/monitoring";

describe("environmentFor", () => {
	it.each([
		["localhost", "development"],
		["127.0.0.1", "development"],
		["staging.linguamentor.example", "staging"],
		["linguamentor.example", "production"],
		["app.staging-like.example", "production"],
	])("treats %s as %s", (hostname, environment) => {
		expect(environmentFor(hostname)).toBe(environment);
	});
});

describe("browserMonitoringOptions", () => {
	it("sends reports to the API's relay route and carries no real DSN", () => {
		const options = browserMonitoringOptions("staging.linguamentor.example");

		expect(options.tunnel).toBe("/api/v1/monitoring/envelope");
		expect(new URL(options.dsn).hostname).toBe("relay.invalid");
		expect(options.environment).toBe("staging");
		expect(options.initialScope.tags.service).toBe("web");
		expect(options.dataCollection.httpBodies).toEqual([]);
	});
});
