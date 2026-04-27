import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { spiceAuthMethod } from "./auth.js";
import { runSpiceCatalog } from "./provider-catalog.js";

const PROVIDER_ID = "spice";

function buildSpiceProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Spice",
    docsPath: "/providers/spice",
    envVars: ["SPICE_API_KEY"],
    auth: [spiceAuthMethod],
    catalog: {
      order: "simple",
      run: runSpiceCatalog,
    },
    // Spice uses x-api-key header instead of Authorization: Bearer,
    // and the OpenAI-completions transport (/v1/chat/completions).
    normalizeConfig: ({ providerConfig }) => {
      const { apiKey, request } = providerConfig;
      const needsApi = providerConfig.api !== "openai-completions";
      // Always mark this provider as needing x-api-key (regardless of where the
      // key lives — inline config or auth profiles).
      const needsApiKeyHeader = providerConfig.apiKeyHeader !== "x-api-key";
      // Also set request.auth when the key is available inline in the config.
      const needsRequestAuth = !!apiKey && !request?.auth;
      if (!needsApi && !needsApiKeyHeader && !needsRequestAuth) {
        return providerConfig;
      }
      return {
        ...providerConfig,
        ...(needsApi ? { api: "openai-completions" as const } : {}),
        ...(needsApiKeyHeader ? { apiKeyHeader: "x-api-key" } : {}),
        ...(needsRequestAuth
          ? {
              request: {
                ...request,
                auth: {
                  mode: "header" as const,
                  headerName: "x-api-key",
                  value: apiKey,
                },
              },
            }
          : {}),
      };
    },
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Spice Provider",
  description: "Bundled Spice AI provider plugin",
  register(api) {
    api.registerProvider(buildSpiceProvider());
  },
});
