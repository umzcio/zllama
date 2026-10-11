import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import tags from "./fixtures/ollama-tags.json";
import version from "./fixtures/ollama-version.json";

const realFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = realFetch;
});

function mockJson(payload: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as unknown as typeof fetch;
}

describe("ollamaAdapter", () => {
  it("declares the ollama kind and full model management", async () => {
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    expect(ollamaAdapter.kind).toBe("ollama");
    expect(ollamaAdapter.capabilities.pullModel).toBe(true);
    expect(ollamaAdapter.capabilities.deleteModel).toBe(true);
    expect(ollamaAdapter.capabilities.copyModel).toBe(true);
    expect(ollamaAdapter.capabilities.runningModels).toBe(true);
  });

  it("returns the version string verbatim", async () => {
    mockJson(version);
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    await expect(ollamaAdapter.getVersion("http://10.0.0.1:11434")).resolves.toBe(
      (version as { version: string }).version
    );
  });

  it("maps /api/tags into ModelSummary, preserving size and digest", async () => {
    mockJson(tags);
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    const models = await ollamaAdapter.listModels("http://10.0.0.1:11434");
    const first = (tags as { models: Array<Record<string, unknown>> }).models[0];

    expect(models).toHaveLength(3);
    expect(models[0].name).toBe(first.name);
    expect(models[0].sizeBytes).toBe(first.size);
    expect(models[0].digest).toBe(first.digest);
  });

  it("surfaces capabilities and context length when the server reports them", async () => {
    mockJson(tags);
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    const models = await ollamaAdapter.listModels("http://10.0.0.1:11434");
    const withVision = models.find((m) => m.capabilities?.includes("vision"));
    expect(withVision).toBeDefined();
    expect(withVision?.contextLength).toBeGreaterThan(0);
  });

  it("allowlists the four paths clients actually proxy", async () => {
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    for (const p of ["/api/generate", "/api/chat", "/api/embed", "/api/tags"]) {
      expect(ollamaAdapter.proxyablePaths).toContain(p);
    }
  });

  it("does not allowlist destructive model management through the proxy", async () => {
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    for (const p of ["/api/delete", "/api/copy", "/api/pull", "/api/create"]) {
      expect(ollamaAdapter.proxyablePaths).not.toContain(p);
    }
  });

  it("bounds getVersion with an AbortSignal so one dead host cannot hang the fan-out", async () => {
    mockJson(version);
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    await ollamaAdapter.getVersion("http://10.0.0.1:11434");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds listModels with an AbortSignal so one dead host cannot hang the fan-out", async () => {
    mockJson(tags);
    const { ollamaAdapter } = await import("@/lib/engines/ollama");
    await ollamaAdapter.listModels("http://10.0.0.1:11434");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
