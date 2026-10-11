import { ollamaAdapter } from "@/lib/engines/ollama";
import { vllmAdapter } from "@/lib/engines/vllm";
import type { EngineAdapter, EngineCapabilities, EngineKind } from "@/lib/engines/types";

export type { EngineAdapter, EngineKind, ModelSummary, EngineCapabilities } from "@/lib/engines/types";
export { assertProxyable } from "@/lib/engines/types";

const ADAPTERS: Record<EngineKind, EngineAdapter> = {
  ollama: ollamaAdapter,
  vllm: vllmAdapter,
};

export function getAdapter(kind: EngineKind): EngineAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) {
    throw new Error(`Unknown engine: ${String(kind)}`);
  }
  return adapter;
}

export function isEngineKind(value: string): value is EngineKind {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, value);
}

// vLLM installs nothing into itself: it is launched against weights already
// on disk, so every model-management capability it declares is
// false and the fix for a refused call is a role declaration, not a
// different endpoint.
const ENGINE_GUIDANCE: Partial<Record<EngineKind, string>> = {
  vllm:
    " vLLM installs nothing into itself — declare the model on the host's role" +
    " and let convergence place the weights in the managed cache.",
};

/**
 * Guards a model-management operation against the endpoint's engine.
 *
 * Returns `null` when the engine supports the capability, or an actionable
 * message when it does not. Every capability an adapter declares is meant to
 * be consulted before the corresponding call is made — declaring
 * `pullModel: false` and then firing an Ollama pull at a vLLM endpoint
 * anyway is what makes the capability matrix decorative.
 *
 * An engine string the adapter registry does not recognize is refused too,
 * never quietly treated as Ollama.
 */
export function capabilityRefusal(
  engine: string,
  capability: keyof EngineCapabilities,
  operation: string
): string | null {
  if (!isEngineKind(engine)) {
    return `This endpoint's engine "${engine}" is not a recognized engine, so ${operation} cannot be attempted against it.`;
  }
  const adapter = getAdapter(engine);
  if (adapter.capabilities[capability]) {
    return null;
  }
  return `This endpoint runs ${adapter.kind}, which does not support ${operation}.${ENGINE_GUIDANCE[adapter.kind] ?? ""}`;
}
