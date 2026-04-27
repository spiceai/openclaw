import {
  createDefaultModelPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildSpiceModelDefinition,
  SPICE_DEFAULT_BASE_URL,
  SPICE_DEFAULT_MODEL_ID,
} from "./models.js";

export const SPICE_DEFAULT_MODEL_REF = `spice/${SPICE_DEFAULT_MODEL_ID}`;

const spicePresetAppliers = createDefaultModelPresetAppliers({
  primaryModelRef: SPICE_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const pluginEndpoint = (
      cfg.plugins?.entries as Record<string, { config?: { endpoint?: string } }> | undefined
    )?.spice?.config?.endpoint?.trim();
    const existingProvider = cfg.models?.providers?.spice as { baseUrl?: unknown } | undefined;
    const existingBaseUrl =
      typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
    const resolvedBaseUrl = pluginEndpoint || existingBaseUrl;

    return {
      providerId: "spice",
      api: "openai-completions" as const,
      baseUrl: resolvedBaseUrl || SPICE_DEFAULT_BASE_URL,
      defaultModel: buildSpiceModelDefinition(),
      defaultModelId: SPICE_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: SPICE_DEFAULT_MODEL_REF, alias: "Spice" }],
    };
  },
});

export function applySpiceProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return spicePresetAppliers.applyProviderConfig(cfg);
}

export function applySpiceConfig(cfg: OpenClawConfig): OpenClawConfig {
  return spicePresetAppliers.applyConfig(cfg);
}
