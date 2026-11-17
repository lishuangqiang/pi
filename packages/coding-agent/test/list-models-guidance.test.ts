import { describe, expect, test, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

interface StubProvider {
	id: string;
	name: string;
	configured: boolean;
	models: readonly unknown[];
}

function stubRuntime(providers: readonly StubProvider[]): ModelRuntime {
	return {
		getError: () => undefined,
		getAvailable: async () => [],
		getProviders: () => providers.map(({ id, name }) => ({ id, name })),
		hasConfiguredAuth: (id: string) => providers.find((provider) => provider.id === id)?.configured === true,
		getModels: (id: string) => providers.find((provider) => provider.id === id)?.models ?? [],
	} as unknown as ModelRuntime;
}

async function printed(runtime: ModelRuntime): Promise<string> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await listModels(runtime);
		return log.mock.calls.map((call) => call.join(" ")).join("\n");
	} finally {
		log.mockRestore();
	}
}

describe("--list-models with no selectable models", () => {
	// #12096: a restart left a llama.cpp router with nothing loaded, and the generic hint sent the
	// reporter to /login even though the connection was still stored.
	test("names configured providers that expose no models", async () => {
		const output = await printed(stubRuntime([{ id: "llama.cpp", name: "llama.cpp", configured: true, models: [] }]));

		expect(output).toContain("configured but expose no models");
		expect(output).toContain("  llama.cpp");
		expect(output).not.toContain("Use /login");
	});

	test("keeps the login guidance when nothing is configured", async () => {
		const output = await printed(
			stubRuntime([
				{ id: "llama.cpp", name: "llama.cpp", configured: false, models: [] },
				{ id: "openai", name: "openai", configured: false, models: [{ id: "gpt-5.5" }] },
			]),
		);

		expect(output).toContain("Use /login");
		expect(output).not.toContain("configured but expose no models");
	});
});
