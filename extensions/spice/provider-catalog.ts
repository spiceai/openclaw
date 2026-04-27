import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  buildSpiceModelDefinition,
  discoverSpiceModels,
  SPICE_DEFAULT_BASE_URL,
} from "./models.js";

export type SpicePluginConfig = {
  endpoint?: string;
  apiKey?: string;
};

function resolveSpicePluginConfig(ctx: ProviderCatalogContext): SpicePluginConfig {
  const entries = (ctx.config.plugins?.entries ?? {}) as Record<
    string,
    { config?: SpicePluginConfig }
  >;
  return entries.spice?.config ?? {};
}

export async function runSpiceCatalog(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
  const pluginConfig = resolveSpicePluginConfig(ctx);

  const apiKey = ctx.resolveProviderApiKey("spice").apiKey ?? pluginConfig.apiKey?.trim() ?? "";
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl =
    (ctx.config.models?.providers as Record<string, { baseUrl?: string }> | undefined)?.[
      "spice"
    ]?.baseUrl?.trim() ?? "";
  const baseUrl = pluginConfig.endpoint?.trim() || explicitBaseUrl || SPICE_DEFAULT_BASE_URL;

  const models = await discoverSpiceModels({ baseUrl, apiKey }).catch(() => [
    buildSpiceModelDefinition(),
  ]);

  return {
    provider: {
      baseUrl,
      api: "openai-completions",
      models,
      apiKey,
      request: {
        auth: {
          mode: "header" as const,
          headerName: "x-api-key",
          value: apiKey,
        },
      },
    },
  };
}
