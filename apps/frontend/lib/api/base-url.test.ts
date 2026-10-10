import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The API address is read when the module loads, so each case sets the env first and imports afresh.

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.resetModules();
	fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function requestedUrl(): Promise<string> {
	const { apiFetch } = await import("@/lib/api/client");
	await apiFetch("/api/v1/writing/exams");
	return fetchMock.mock.calls[0][0] as string;
}

describe("API base URL", () => {
	it("calls the page's own origin by relative path when no address is set", async () => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");

		expect(await requestedUrl()).toBe("/api/v1/writing/exams");
	});

	it("treats an unset variable the same as an empty one", async () => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", undefined);

		expect(await requestedUrl()).toBe("/api/v1/writing/exams");
	});

	it("still honours an explicit address, as the local stack sets", async () => {
		vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:3000");

		expect(await requestedUrl()).toBe("http://localhost:3000/api/v1/writing/exams");
	});
});
