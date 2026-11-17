import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

/**
 * `providersWithoutModels` names providers that are already configured but expose no models. Telling
 * those users to log in sends them looking for a credential that is not missing.
 */
export function formatNoModelsAvailableMessage(providersWithoutModels: readonly string[] = []): string {
	if (providersWithoutModels.length === 0) {
		return `No models available. ${getProviderLoginHelp()}`;
	}
	return [
		"No models available. These providers are configured but expose no models:",
		...providersWithoutModels.map((name) => `  ${name}`),
		"Log in again only if your provider is missing from that list. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
