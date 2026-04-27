import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createAnthropicVertexStreamFnForModel } from "../anthropic-vertex-stream.js";
import { createOpenAIWebSocketStreamFn } from "../openai-ws-stream.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { createBoundaryAwareStreamFnForModel } from "../provider-transport-stream.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();

export function resolveEmbeddedAgentBaseStreamFn(params: {
  session: { agent: { streamFn?: StreamFn } };
}): StreamFn | undefined {
  const cached = embeddedAgentBaseStreamFnCache.get(params.session);
  if (cached !== undefined || embeddedAgentBaseStreamFnCache.has(params.session)) {
    return cached;
  }
  const baseStreamFn = params.session.agent.streamFn;
  embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
  return baseStreamFn;
}

export function resetEmbeddedAgentBaseStreamFnCacheForTest(): void {
  embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();
}

export function describeEmbeddedAgentStreamStrategy(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  shouldUseWebSocketTransport: boolean;
  wsApiKey?: string;
  model: EmbeddedRunAttemptParams["model"];
}): string {
  if (params.providerStreamFn) {
    return "provider";
  }
  if (params.shouldUseWebSocketTransport) {
    return params.wsApiKey ? "openai-websocket" : "session-http-fallback";
  }
  if (params.model.provider === "anthropic-vertex") {
    return "anthropic-vertex";
  }
  if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
    return createBoundaryAwareStreamFnForModel(params.model)
      ? `boundary-aware:${params.model.api}`
      : "stream-simple";
  }
  return "session-custom";
}

export async function resolveEmbeddedAgentApiKey(params: {
  provider: string;
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): Promise<string | undefined> {
  const resolvedApiKey = params.resolvedApiKey?.trim();
  if (resolvedApiKey) {
    return resolvedApiKey;
  }
  return params.authStorage ? await params.authStorage.getApiKey(params.provider) : undefined;
}

export function resolveEmbeddedAgentStreamFn(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  shouldUseWebSocketTransport: boolean;
  wsApiKey?: string;
  sessionId: string;
  signal?: AbortSignal;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
  config?: EmbeddedRunAttemptParams["config"] | undefined;
}): StreamFn {
  if (params.providerStreamFn) {
    const inner = params.providerStreamFn;
    const normalizeContext = (context: Parameters<StreamFn>[1]) =>
      context.systemPrompt
        ? {
            ...context,
            systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
          }
        : context;
    // Provider-owned transports bypass pi-coding-agent's default auth lookup,
    // so keep injecting the resolved runtime apiKey for streamSimple-compatible
    // transports that still read credentials from options.apiKey.
    if (params.authStorage || params.resolvedApiKey) {
      const { authStorage, model, resolvedApiKey } = params;
      return async (m, context, options) => {
        const apiKey = await resolveEmbeddedAgentApiKey({
          provider: model.provider,
          resolvedApiKey,
          authStorage,
        });
        return inner(m, normalizeContext(context), {
          ...options,
          apiKey: apiKey ?? options?.apiKey,
        });
      };
    }
    return (m, context, options) => inner(m, normalizeContext(context), options);
  }

  const currentStreamFn = params.currentStreamFn ?? streamSimple;
  if (params.shouldUseWebSocketTransport) {
    return params.wsApiKey
      ? createOpenAIWebSocketStreamFn(params.wsApiKey, params.sessionId, {
          signal: params.signal,
          managerOptions: {
            request: getModelProviderRequestTransport(params.model),
          },
        })
      : currentStreamFn;
  }

  if (params.model.provider === "anthropic-vertex") {
    return createAnthropicVertexStreamFnForModel(params.model);
  }

  // Always prefer the boundary-aware transport when one exists for this model's api.
  // This ensures providers with a custom apiKeyHeader (e.g. x-api-key for Spice) go
  // through the correct transport instead of the session-inherited streamSimple wrapper.
  const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
  if (boundaryAwareStreamFn) {
    if (params.authStorage || params.resolvedApiKey) {
      const { authStorage, model, resolvedApiKey, config } = params;
      return async (m, context, options) => {
        const apiKey = await resolveEmbeddedAgentApiKey({
          provider: model.provider,
          resolvedApiKey,
          authStorage,
        });
        let authedModel = m;
        if (apiKey) {
          const providerCfg = (
            config?.models?.providers as Record<string, { apiKeyHeader?: string }> | undefined
          )?.[m.provider];
          const apiKeyHeader = providerCfg?.apiKeyHeader?.trim();
          if (apiKeyHeader && apiKeyHeader.toLowerCase() !== "authorization") {
            authedModel = {
              ...m,
              headers: {
                ...(m.headers ?? {}),
                [apiKeyHeader]: apiKey,
                Authorization: null as unknown as string,
              },
            };
          }
        }
        return boundaryAwareStreamFn(authedModel, context, {
          ...options,
          apiKey: apiKey ?? options?.apiKey,
        });
      };
    }
    return boundaryAwareStreamFn;
  }

  if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
    // No boundary-aware transport; fall through to currentStreamFn below.
  }

  return currentStreamFn;
}
