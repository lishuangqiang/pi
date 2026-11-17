import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { refreshModelCatalogs } from "../src/package-manager-cli.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pi update --models", () => {
	// The catalog refresh used to build a bare ModelRuntime, so providers that extensions register at
	// runtime (llama.cpp) were skipped while the command still reported success.
	it("registers built-in extension providers before refreshing", async () => {
		const registerNativeProvider = vi.fn();
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
		vi.spyOn(ModelRuntime, "create").mockResolvedValue({
			registerNativeProvider,
			registerProvider: vi.fn(),
			registerVirtualModel: vi.fn(),
			refresh,
		} as unknown as ModelRuntime);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await refreshModelCatalogs(tmpdir(), builtInExtensions);

		expect(registerNativeProvider.mock.calls.map(([provider]) => provider.id)).toContain("llama.cpp");
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: true, force: true, signal: expect.any(AbortSignal) });
	});
});
