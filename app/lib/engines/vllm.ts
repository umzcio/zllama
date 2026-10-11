import { ENGINE_PROBE_TIMEOUT_MS } from "@/lib/engines/types";
import type { EngineAdapter, ModelSummary } from "@/lib/engines/types";

interface VllmModel {
  id: string;
  max_model_len?: number;
  root?: string;
}

async function vllmFetch<T>(baseUrl: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(ENGINE_PROBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`vLLM API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const vllmAdapter: EngineAdapter = {
  kind: "vllm",
  capabilities: {
    listModels: true,
    showModel: false,
    pullModel: false,
    deleteModel: false,
    copyModel: false,
    runningModels: false,
    versionCheck: true,
  },
  // Inference and read-only inspection only. The sleep/wake and
  // collective_rpc endpoints that VLLM_SERVER_DEV_MODE exposes permit
  // arbitrary RPC execution and must never be reachable through the gateway.
  proxyablePaths: [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/models",
    "/version",
    "/health",
  ],
  async getVersion(baseUrl: string): Promise<string> {
    const data = await vllmFetch<{ version: string }>(baseUrl, "/version");
    return data.version;
  },
  async listModels(baseUrl: string): Promise<ModelSummary[]> {
    const data = await vllmFetch<{ data?: VllmModel[] }>(baseUrl, "/v1/models");
    return (data.data ?? []).map((m) => ({
      name: m.id,
      contextLength: m.max_model_len,
      servedPath: m.root,
    }));
  },
};
