export type EngineKind = "ollama" | "vllm";

// Budget for read-only health/inventory probes (getVersion, listModels) made
// during fan-out calls like /api/dashboard, which hit every registered
// endpoint. Deliberately not applied to mutating calls (pull/delete/copy),
// which can legitimately run long.
export const ENGINE_PROBE_TIMEOUT_MS = 4000;

export interface ModelSummary {
  name: string;
  sizeBytes?: number;
  digest?: string;
  contextLength?: number;
  servedPath?: string;
  capabilities?: string[];
}

export interface EngineCapabilities {
  listModels: boolean;
  showModel: boolean;
  pullModel: boolean;
  deleteModel: boolean;
  copyModel: boolean;
  runningModels: boolean;
  versionCheck: boolean;
}

export interface EngineAdapter {
  kind: EngineKind;
  capabilities: EngineCapabilities;
  proxyablePaths: string[];
  getVersion(baseUrl: string): Promise<string>;
  listModels(baseUrl: string): Promise<ModelSummary[]>;
}

export function assertProxyable(allowed: string[], path: string): boolean {
  if (!path) return false;
  const withoutQuery = path.split("?")[0];
  if (withoutQuery.includes("..")) return false;
  return allowed.includes(withoutQuery);
}
