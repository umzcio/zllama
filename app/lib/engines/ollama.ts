import { getVersion, listModels } from "@/lib/ollama";
import { ENGINE_PROBE_TIMEOUT_MS } from "@/lib/engines/types";
import type { EngineAdapter, ModelSummary } from "@/lib/engines/types";

interface TagDetails {
  context_length?: number;
}

interface TagModel {
  name: string;
  size?: number;
  digest?: string;
  details?: TagDetails;
  capabilities?: string[];
}

export const ollamaAdapter: EngineAdapter = {
  kind: "ollama",
  capabilities: {
    listModels: true,
    showModel: true,
    pullModel: true,
    deleteModel: true,
    copyModel: true,
    runningModels: true,
    versionCheck: true,
  },
  // Only what clients actually send through /api/proxy, plus read-only
  // inspection. Model mutation goes through the admin routes, which apply
  // their own authorization — it must not be reachable via the gateway.
  proxyablePaths: [
    "/api/generate",
    "/api/chat",
    "/api/embed",
    "/api/embeddings",
    "/api/tags",
    "/api/ps",
    "/api/show",
    "/api/version",
  ],
  async getVersion(baseUrl: string): Promise<string> {
    const res = await getVersion(baseUrl, ENGINE_PROBE_TIMEOUT_MS);
    return res.version;
  },
  async listModels(baseUrl: string): Promise<ModelSummary[]> {
    const data = await listModels(baseUrl, ENGINE_PROBE_TIMEOUT_MS);
    const models = (data.models ?? []) as unknown as TagModel[];
    return models.map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      digest: m.digest,
      contextLength: m.details?.context_length,
      capabilities: m.capabilities,
    }));
  },
};
