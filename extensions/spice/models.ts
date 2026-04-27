import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export const SPICE_DEFAULT_BASE_URL = "http://localhost:8090/v1";
export const SPICE_DEFAULT_MODEL_ID = "openai";
const SPICE_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const log = createSubsystemLogger("agents/spice");

type SpiceModelShape = {
  id?: unknown;
};

type SpiceModelsResponse = {
  data?: SpiceModelShape[];
};

export function buildSpiceModelDefinition(id = SPICE_DEFAULT_MODEL_ID): ModelDefinitionConfig {
  const compat = {
    supportsDeveloperRole: true,
    supportsUsageInStreaming: true,
    supportsStrictMode: true,
    supportsEmptyStopRetry: true,
  };
  return {
    id,
    name: id === SPICE_DEFAULT_MODEL_ID ? "Spice Model" : id,
    reasoning: false,
    input: ["text"],
    cost: SPICE_DEFAULT_COST,
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat,
  };
}

export async function discoverSpiceModels(params: {
  baseUrl: string;
  apiKey: string;
}): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [buildSpiceModelDefinition()];
  }
  try {
    const modelsUrl = `${params.baseUrl.replace(/\/+$/, "")}/models`;
    const { response, release } = await fetchWithSsrFGuard({
      url: modelsUrl,
      timeoutMs: 5_000,
      auditContext: "spice.models",
      init: { headers: { "x-api-key": params.apiKey } },
    });
    try {
      if (!response.ok) {
        log.warn(`Failed to discover Spice models: HTTP ${response.status}`);
        return [buildSpiceModelDefinition()];
      }
      const body = (await response.json()) as SpiceModelsResponse;
      const discovered = (body.data ?? [])
        .map((m) => {
          const id = typeof m.id === "string" ? m.id.trim() : "";
          return id ? buildSpiceModelDefinition(id) : null;
        })
        .filter((m): m is ModelDefinitionConfig => m !== null);
      return discovered.length > 0 ? discovered : [buildSpiceModelDefinition()];
    } finally {
      await release();
    }
  } catch (error) {
    log.warn(`Failed to discover Spice models: ${String(error)}`);
    return [buildSpiceModelDefinition()];
  }
}
