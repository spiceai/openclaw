import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/core";
import {
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  type SecretInput,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import { SPICE_DEFAULT_BASE_URL } from "./models.js";
import { applySpiceConfig, SPICE_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "spice";
const PROFILE_ID = "spice:default";

function resolveExistingPluginConfig(ctx: ProviderAuthContext): { endpoint?: string } {
  const entries = ctx.config.plugins?.entries as
    | Record<string, { config?: { endpoint?: string } }>
    | undefined;
  return entries?.[PROVIDER_ID]?.config ?? {};
}

export const spiceAuthMethod: ProviderAuthMethod = {
  id: "api-key",
  label: "Spice API key",
  hint: "API key from Spice Cloud or self-hosted Spice instance",
  kind: "api_key",
  wizard: {
    groupLabel: "Spice",
    groupHint: "AI gateway for enterprise data",
  },
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const existing = resolveExistingPluginConfig(ctx);

    const endpoint = await ctx.prompter.text({
      message: "Spice endpoint URL",
      initialValue: existing.endpoint?.trim() || SPICE_DEFAULT_BASE_URL,
      placeholder: "http://localhost:8090/v1",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Endpoint URL is required";
        try {
          new URL(trimmed);
        } catch {
          return "Must be a valid URL (e.g. http://localhost:8090/v1)";
        }
      },
    });

    let capturedSecretInput: SecretInput | undefined;
    let capturedCredential = false;
    let capturedMode: "plaintext" | "ref" | undefined;

    await ensureApiKeyFromOptionEnvOrPrompt({
      token: normalizeOptionalSecretInput(
        (ctx.opts as Record<string, unknown> | undefined)?.spiceApiKey,
      ),
      tokenProvider: normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
      secretInputMode:
        ctx.allowSecretRefPrompt === false
          ? (ctx.secretInputMode ?? "plaintext")
          : ctx.secretInputMode,
      config: ctx.config,
      env: ctx.env,
      expectedProviders: [PROVIDER_ID],
      provider: PROVIDER_ID,
      envLabel: "SPICE_API_KEY",
      promptMessage: "Enter Spice API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: ctx.prompter,
      setCredential: async (apiKey, mode) => {
        capturedSecretInput = apiKey;
        capturedCredential = true;
        capturedMode = mode;
      },
    });

    if (!capturedCredential) {
      throw new Error(`Missing API key for provider "${PROVIDER_ID}".`);
    }

    const endpointTrimmed = endpoint.trim();
    const configWithEndpoint = {
      ...ctx.config,
      plugins: {
        ...ctx.config.plugins,
        entries: {
          ...ctx.config.plugins?.entries,
          [PROVIDER_ID]: {
            ...(ctx.config.plugins?.entries?.[PROVIDER_ID] ?? {}),
            config: {
              ...(existing as object),
              endpoint: endpointTrimmed,
            },
          },
        },
      },
    };

    return {
      profiles: [
        {
          profileId: PROFILE_ID,
          credential: buildApiKeyCredential(
            PROVIDER_ID,
            capturedSecretInput ?? "",
            undefined,
            capturedMode ? { secretInputMode: capturedMode, config: ctx.config } : undefined,
          ),
        },
      ],
      configPatch: applySpiceConfig(configWithEndpoint),
      defaultModel: SPICE_DEFAULT_MODEL_REF,
    };
  },
};
