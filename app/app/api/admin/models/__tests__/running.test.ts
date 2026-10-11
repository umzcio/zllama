// GET /api/admin/models/running calls lib/ollama's listRunningModels, which
// hits Ollama's /api/ps. vLLM has no equivalent endpoint, so it must be
// refused via the capability matrix (400, actionable message) rather than
// firing the request and 404ing upstream.

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
  const { GET } = await import("@/app/api/admin/models/running/route");
  return GET(new NextRequest(`http://localhost/api/admin/models/running?serverId=${serverId}`));
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
};

describe("GET /api/admin/models/running", () => {
  it("still lists running models for an Ollama endpoint, unchanged response shape", async () => {
    findUnique().mockResolvedValue(ollamaServer);
    const psPayload = { models: [{ name: "llama3.1:8b", size_vram: 123 }] };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => psPayload,
    }) as unknown as typeof fetch;

    const res = await call("srv_1");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual(psPayload);
  });

  it("refuses a vLLM endpoint with 400 instead of 404ing upstream", async () => {
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn();

    const res = await call("srv_2");
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/vllm/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
