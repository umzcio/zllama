import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import models from "./fixtures/vllm-models.json";
import version from "./fixtures/vllm-version.json";

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

describe("vllmAdapter", () => {
  it("declares the vllm kind and no model management", async () => {
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    expect(vllmAdapter.kind).toBe("vllm");
    expect(vllmAdapter.capabilities.pullModel).toBe(false);
    expect(vllmAdapter.capabilities.deleteModel).toBe(false);
    expect(vllmAdapter.capabilities.copyModel).toBe(false);
    expect(vllmAdapter.capabilities.runningModels).toBe(false);
    expect(vllmAdapter.capabilities.listModels).toBe(true);
  });

  it("returns a dev-build version string verbatim without parsing it", async () => {
    mockJson(version);
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    const v = await vllmAdapter.getVersion("http://10.0.0.2:8888");
    expect(v).toBe((version as { version: string }).version);
    expect(v).toContain("dev");
  });

  it("maps /v1/models data[].id into ModelSummary names", async () => {
    mockJson(models);
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    const list = await vllmAdapter.listModels("http://10.0.0.2:8888");
    const data = (models as { data: Array<{ id: string; max_model_len?: number; root?: string }> }).data;

    expect(list).toHaveLength(data.length);
    expect(list[0].name).toBe(data[0].id);
    expect(list[0].contextLength).toBe(data[0].max_model_len);
  });

  it("maps /v1/models data[].root into ModelSummary.servedPath", async () => {
    mockJson(models);
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    const list = await vllmAdapter.listModels("http://10.0.0.2:8888");
    const data = (models as { data: Array<{ root?: string }> }).data;

    expect(list[0].servedPath).toBe(data[0].root);
    expect(list[0].servedPath).toBe("/model");
  });

  it("reports no size or digest, which vLLM does not expose", async () => {
    mockJson(models);
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    const list = await vllmAdapter.listModels("http://10.0.0.2:8888");
    expect(list[0].sizeBytes).toBeUndefined();
    expect(list[0].digest).toBeUndefined();
  });

  it("allowlists inference and read-only paths", async () => {
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    for (const p of ["/v1/chat/completions", "/v1/completions", "/v1/models", "/health"]) {
      expect(vllmAdapter.proxyablePaths).toContain(p);
    }
  });

  it("never allowlists the dev-mode control endpoints", async () => {
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    for (const p of ["/collective_rpc", "/sleep", "/wake_up", "/reset_prefix_cache"]) {
      expect(vllmAdapter.proxyablePaths).not.toContain(p);
    }
  });

  it("throws a clear error when the server returns a non-OK status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    await expect(vllmAdapter.listModels("http://10.0.0.2:8888")).rejects.toThrow(/503/);
  });

  it("bounds getVersion with an AbortSignal so one dead host cannot hang the fan-out", async () => {
    mockJson(version);
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    await vllmAdapter.getVersion("http://10.0.0.2:8888");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds listModels with an AbortSignal so one dead host cannot hang the fan-out", async () => {
    mockJson(models);
    const { vllmAdapter } = await import("@/lib/engines/vllm");
    await vllmAdapter.listModels("http://10.0.0.2:8888");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
