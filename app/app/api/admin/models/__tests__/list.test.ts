// GET /api/admin/models used to call lib/ollama's listModels unconditionally,
// which requests Ollama's /api/tags. vLLM has no /api/tags (it lists models
// at /v1/models), so an operator on a vLLM endpoint got a 502 instead of a
// model list. The route must go through the engine adapter for non-Ollama
// engines, while Ollama keeps its existing rich per-model response shape
// (size, digest, modified_at, family/parameter_size/quantization_level) that
// the admin models page renders directly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: { endpoint: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ kind: "user", userId: "u1", role: "admin" })),
}));

import { prisma } from "@/lib/prisma";

const findUnique = () => prisma.endpoint.findUnique as ReturnType<typeof vi.fn>;
const realFetch = global.fetch;

async function call(serverId: string) {
  const { GET } = await import("@/app/api/admin/models/route");
  return GET(new NextRequest(`http://localhost/api/admin/models?serverId=${serverId}`));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = realFetch;
});

const ollamaServer = {
  id: "srv_1",
  url: "http://10.0.0.10:11434",
  engine: "ollama",
  active: true,
};

const vllmServer = {
  id: "srv_2",
  url: "http://10.0.0.20:8888",
  engine: "vllm",
  active: true,
  hosts: [] as { nodeName: string; models: { name: string; sizeBytes: number | null }[] }[],
};

describe("GET /api/admin/models", () => {
  it("returns Ollama's full per-model detail unchanged", async () => {
    findUnique().mockResolvedValue(ollamaServer);
    const tagsPayload = {
      models: [
        {
          name: "llama3.1:8b",
          model: "llama3.1:8b",
          modified_at: "2026-01-01T00:00:00Z",
          size: 4700000000,
          digest: "abc123",
          details: {
            parent_model: "",
            format: "gguf",
            family: "llama",
            families: ["llama"],
            parameter_size: "8B",
            quantization_level: "Q4_0",
          },
        },
      ],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => tagsPayload,
    }) as unknown as typeof fetch;

    const res = await call("srv_1");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual(tagsPayload);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.10:11434/api/tags");
  });

  it("lists vLLM models via /v1/models instead of failing on /api/tags", async () => {
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "meta-llama/Llama-3.1-8B",
                max_model_len: 131072,
                root: "/model",
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const res = await call("srv_2");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.models).toHaveLength(1);
    expect(data.models[0].name).toBe("meta-llama/Llama-3.1-8B");
  });

  it("reports unreported vLLM facts as null, never fabricated zero/empty values", async () => {
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "meta-llama/Llama-3.1-8B",
                max_model_len: 131072,
                root: "/model",
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const res = await call("srv_2");
    const data = await res.json();

    expect(data.models[0].size).toBeNull();
    expect(data.models[0].digest).toBeNull();
    expect(data.models[0].details).toBeNull();
    expect(data.models[0].contextLength).toBe(131072);
    expect(data.models[0].servedPath).toBe("/model");
  });

  it("returns 502 when the upstream call fails", async () => {
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const res = await call("srv_2");
    expect(res.status).toBe(502);
  });

  it("includes hostModels from linked hosts' vllm HostModel rows for a vLLM endpoint", async () => {
    findUnique().mockResolvedValue({
      ...vllmServer,
      hosts: [
        {
          nodeName: "gpu-node-4",
          models: [
            { name: "model", sizeBytes: 42_000_000_000 },
            { name: "another-model", sizeBytes: null },
          ],
        },
        { nodeName: "gpu-node-1", models: [{ name: "gpt2", sizeBytes: 500_000_000 }] },
      ],
    });
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const res = await call("srv_2");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.hostModels).toEqual([
      { hostNodeName: "gpu-node-4", name: "model", sizeBytes: 42_000_000_000 },
      { hostNodeName: "gpu-node-4", name: "another-model", sizeBytes: null },
      { hostNodeName: "gpu-node-1", name: "gpt2", sizeBytes: 500_000_000 },
    ]);
  });

  it("returns an empty hostModels array for a vLLM endpoint with no linked hosts", async () => {
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const res = await call("srv_2");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.hostModels).toEqual([]);
  });

  it("never merges hostModels into the served models list", async () => {
    findUnique().mockResolvedValue({
      ...vllmServer,
      hosts: [{ nodeName: "gpu-node-4", models: [{ name: "model", sizeBytes: 1 }] }],
    });
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: "nemotron-3-super", max_model_len: 8192, root: "/model" }],
          }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const res = await call("srv_2");
    const data = await res.json();

    // A served model and its on-disk directory can carry entirely different
    // names (nemotron-3-super served from a directory literally named
    // "model") — the two lists are returned side by side, never joined.
    expect(data.models).toHaveLength(1);
    expect(data.models[0].name).toBe("nemotron-3-super");
    expect(data.hostModels).toEqual([{ hostNodeName: "gpu-node-4", name: "model", sizeBytes: 1 }]);
  });

  it("does not add a hostModels field for Ollama endpoints", async () => {
    findUnique().mockResolvedValue(ollamaServer);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    }) as unknown as typeof fetch;

    const res = await call("srv_1");
    const data = await res.json();

    expect(data.hostModels).toBeUndefined();
  });

  it("queries linked hosts' HostModel rows scoped to runtimeKind vllm", async () => {
    // A regression guard on the Prisma query shape itself: forgetting the
    // runtimeKind filter would let an Ollama-runtime row on a host that also
    // runs Ollama leak into a vLLM endpoint's on-disk inventory.
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;

    await call("srv_2");

    expect(findUnique()).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "srv_2" },
        include: expect.objectContaining({
          hosts: expect.objectContaining({
            include: expect.objectContaining({
              models: { where: { runtimeKind: "vllm" } },
            }),
          }),
        }),
      })
    );
  });

  it("returns 502 for an endpoint with an unrecognized engine, without hostModels", async () => {
    findUnique().mockResolvedValue({ ...vllmServer, engine: "mystery" });

    const res = await call("srv_2");
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.hostModels).toBeUndefined();
  });

  it("aggregates hostModels across several linked hosts, skipping one with none", async () => {
    findUnique().mockResolvedValue({
      ...vllmServer,
      hosts: [
        { nodeName: "gpu-node-4", models: [{ name: "model", sizeBytes: 10 }] },
        { nodeName: "gpu-node-1", models: [] },
        { nodeName: "spark-1", models: [{ name: "checkpoint-a", sizeBytes: 20 }] },
      ],
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;

    const res = await call("srv_2");
    const data = await res.json();

    expect(data.hostModels).toEqual([
      { hostNodeName: "gpu-node-4", name: "model", sizeBytes: 10 },
      { hostNodeName: "spark-1", name: "checkpoint-a", sizeBytes: 20 },
    ]);
  });

  it("preserves an unknown hostModels size as null, never fabricating zero", async () => {
    findUnique().mockResolvedValue({
      ...vllmServer,
      hosts: [{ nodeName: "gpu-node-4", models: [{ name: "model", sizeBytes: null }] }],
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;

    const res = await call("srv_2");
    const data = await res.json();

    expect(data.hostModels[0].sizeBytes).toBeNull();
    expect(data.hostModels[0].sizeBytes).not.toBe(0);
  });

  it("returns 400 when serverId is missing", async () => {
    const { GET } = await import("@/app/api/admin/models/route");
    const res = await GET(new NextRequest("http://localhost/api/admin/models"));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/serverId/i);
    expect(findUnique()).not.toHaveBeenCalled();
  });

  it("does not call the vLLM adapter for an Ollama endpoint", async () => {
    findUnique().mockResolvedValue(ollamaServer);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    }) as unknown as typeof fetch;

    await call("srv_1");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.10:11434/api/tags");
  });
});
