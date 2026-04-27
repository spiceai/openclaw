import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import {
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "./model-auth-markers.js";
import type {
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
} from "./models-config.providers.secrets.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "./models-config.providers.secrets.js";
import { findNormalizedProviderValue } from "./provider-id.js";

const log = createSubsystemLogger("agents/model-providers");

const PROVIDER_IMPLICIT_MERGERS: Partial<
  Record<
    string,
    (params: { existing: ProviderConfig | undefined; implicit: ProviderConfig }) => ProviderConfig
  >
> = {
  ollama: ({ implicit }) => implicit,
  // The catalog run applies plugin-config endpoint precedence; its baseUrl and
  // request.auth are authoritative. Let existing config win on everything else
  // so user customizations (models list, api overrides) survive.
  spice: ({ implicit, existing }) => ({
    ...implicit,
    ...existing,
    baseUrl: implicit.baseUrl,
    // Preserve catalog auth when user config has no explicit request override.
    ...(existing?.request ? {} : { request: implicit.request }),
  }),
};

const PLUGIN_DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;

type ImplicitProviderParams = {
  agentDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
};

type ImplicitProviderContext = ImplicitProviderParams & {
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: ProviderApiKeyResolver;
  resolveProviderAuth: ProviderAuthResolver;
};

// Default timeout for non-live mode. Providers with internal timeouts (Ollama, LMStudio)
// use ~5s; this cap prevents plugins without internal timeouts from stalling indefinitely.
const NON_LIVE_PROVIDER_CATALOG_TIMEOUT_MS = 10_000;

function resolveLiveProviderCatalogTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  const raw = env.OPENCLAW_LIVE_PROVIDER_DISCOVERY_TIMEOUT_MS?.trim();
  if (!live) {
    if (!raw) {
      return NON_LIVE_PROVIDER_CATALOG_TIMEOUT_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : NON_LIVE_PROVIDER_CATALOG_TIMEOUT_MS;
  }
  if (!raw) {
    return 15_000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function resolveProviderDiscoveryFilter(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] | undefined {
  const { config, workspaceDir, env } = params;
  const testRaw = env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS?.trim();
  if (testRaw) {
    const ids = testRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return ids.length > 0 ? [...new Set(ids)] : undefined;
  }
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return undefined;
  }
  const rawValues = [
    env.OPENCLAW_LIVE_PROVIDERS?.trim(),
    env.OPENCLAW_LIVE_GATEWAY_PROVIDERS?.trim(),
  ].filter((value): value is string => Boolean(value && value !== "all"));
  if (rawValues.length === 0) {
    return undefined;
  }
  const ids = rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return undefined;
  }
  const pluginIds = new Set<string>();
  for (const id of ids) {
    const owners =
      resolveOwningPluginIdsForProvider({
        provider: id,
        config,
        workspaceDir,
        env,
      }) ?? [];
    if (owners.length > 0) {
      for (const owner of owners) {
        pluginIds.add(owner);
      }
      continue;
    }
    pluginIds.add(id);
  }
  return pluginIds.size > 0
    ? [...pluginIds].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

export function resolveProviderDiscoveryFilterForTest(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] | undefined {
  return resolveProviderDiscoveryFilter(params);
}

function mergeImplicitProviderSet(
  target: Record<string, ProviderConfig>,
  additions: Record<string, ProviderConfig> | undefined,
): void {
  if (!additions) {
    return;
  }
  for (const [key, value] of Object.entries(additions)) {
    target[key] = value;
  }
}

function mergeImplicitProviderConfig(params: {
  providerId: string;
  existing: ProviderConfig | undefined;
  implicit: ProviderConfig;
}): ProviderConfig {
  const { providerId, existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  const merge = PROVIDER_IMPLICIT_MERGERS[providerId];
  if (merge) {
    return merge({ existing, implicit });
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}

function resolveConfiguredImplicitProvider(params: {
  configuredProviders?: Record<string, ProviderConfig> | null;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  for (const providerId of params.providerIds) {
    const configured = findNormalizedProviderValue(
      params.configuredProviders ?? undefined,
      providerId,
    );
    if (configured) {
      return configured;
    }
  }
  return undefined;
}

function resolveExistingImplicitProviderFromContext(params: {
  ctx: ImplicitProviderContext;
  providerIds: readonly string[];
}): ProviderConfig | undefined {
  return (
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.explicitProviders,
      providerIds: params.providerIds,
    }) ??
    resolveConfiguredImplicitProvider({
      configuredProviders: params.ctx.config?.models?.providers,
      providerIds: params.providerIds,
    })
  );
}

async function resolvePluginImplicitProviders(
  ctx: ImplicitProviderContext,
  providers: import("../plugins/types.js").ProviderPlugin[],
  order: import("../plugins/types.js").ProviderDiscoveryOrder,
): Promise<Record<string, ProviderConfig> | undefined> {
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const discovered: Record<string, ProviderConfig> = {};
  const catalogConfig = buildPluginCatalogConfig(ctx);
  const timeoutMs = resolveLiveProviderCatalogTimeoutMs(ctx.env);

  // Run all provider catalog calls concurrently so N providers timing out costs
  // max(timeouts) instead of sum(timeouts). Merge results in original order to
  // preserve provider precedence.
  const catalogResults = await Promise.all(
    byOrder[order].map((provider) => {
      const resolveCatalogProviderApiKey = (providerId?: string) => {
        const resolvedProviderId = providerId?.trim() || provider.id;
        const resolved = ctx.resolveProviderApiKey(resolvedProviderId);
        if (resolved.apiKey) {
          return resolved;
        }

        if (
          !findNormalizedProviderValue(
            {
              [provider.id]: true,
              ...Object.fromEntries((provider.aliases ?? []).map((alias) => [alias, true])),
              ...Object.fromEntries((provider.hookAliases ?? []).map((alias) => [alias, true])),
            },
            resolvedProviderId,
          )
        ) {
          return resolved;
        }

        const synthetic = provider.resolveSyntheticAuth?.({
          config: catalogConfig,
          provider: resolvedProviderId,
          providerConfig: catalogConfig.models?.providers?.[resolvedProviderId],
        });
        const syntheticApiKey = synthetic?.apiKey?.trim();
        if (!syntheticApiKey) {
          return resolved;
        }

        return {
          apiKey: isNonSecretApiKeyMarker(syntheticApiKey)
            ? syntheticApiKey
            : resolveNonEnvSecretRefApiKeyMarker("file"),
          discoveryApiKey: undefined,
        };
      };

      return runProviderCatalogWithTimeout({
        provider,
        config: catalogConfig,
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        env: ctx.env,
        resolveProviderApiKey: resolveCatalogProviderApiKey,
        resolveProviderAuth: (providerId, options) =>
          ctx.resolveProviderAuth(providerId?.trim() || provider.id, options),
        timeoutMs,
      }).then((result) => ({ provider, result }));
    }),
  );

  for (const { provider, result } of catalogResults) {
    if (!result) {
      continue;
    }
    const normalizedResult = normalizePluginDiscoveryResult({
      provider,
      result,
    });
    for (const [providerId, implicitProvider] of Object.entries(normalizedResult)) {
      discovered[providerId] = mergeImplicitProviderConfig({
        providerId,
        existing:
          discovered[providerId] ??
          resolveExistingImplicitProviderFromContext({
            ctx,
            providerIds: [
              providerId,
              provider.id,
              ...(provider.aliases ?? []),
              ...(provider.hookAliases ?? []),
            ],
          }),
        implicit: implicitProvider,
      });
    }
  }
  return Object.keys(discovered).length > 0 ? discovered : undefined;
}

function buildPluginCatalogConfig(ctx: ImplicitProviderContext): OpenClawConfig {
  if (!ctx.explicitProviders || Object.keys(ctx.explicitProviders).length === 0) {
    return ctx.config ?? {};
  }
  return {
    ...ctx.config,
    models: {
      ...ctx.config?.models,
      providers: {
        ...ctx.config?.models?.providers,
        ...ctx.explicitProviders,
      },
    },
  };
}

async function runProviderCatalogWithTimeout(
  params: Parameters<typeof runProviderCatalog>[0] & {
    timeoutMs: number | null;
  },
): Promise<Awaited<ReturnType<typeof runProviderCatalog>> | undefined> {
  const catalogRun = runProviderCatalog(params);
  const timeoutMs = params.timeoutMs ?? undefined;
  if (!timeoutMs) {
    return await catalogRun;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      catalogRun,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`provider catalog timed out after ${timeoutMs}ms: ${params.provider.id}`),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    const message = formatErrorMessage(error);
    if (message.includes("provider catalog timed out after")) {
      log.warn(`${message}; skipping provider discovery`);
      return undefined;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function resolveImplicitProviders(
  params: ImplicitProviderParams,
): Promise<NonNullable<OpenClawConfig["models"]>["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const env = params.env ?? process.env;
  let authStore: ReturnType<typeof ensureAuthProfileStore> | undefined;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    }));
  const context: ImplicitProviderContext = {
    ...params,
    get authStore() {
      return getAuthStore();
    },
    env,
    resolveProviderApiKey: createProviderApiKeyResolver(env, getAuthStore, params.config),
    resolveProviderAuth: createProviderAuthResolver(env, getAuthStore, params.config),
  };
  const discoveryProviders = await resolvePluginDiscoveryProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: resolveProviderDiscoveryFilter({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env,
    }),
  });

  for (const order of PLUGIN_DISCOVERY_ORDERS) {
    const result = await resolvePluginImplicitProviders(context, discoveryProviders, order);
    mergeImplicitProviderSet(providers, result);
  }

  return providers;
}
