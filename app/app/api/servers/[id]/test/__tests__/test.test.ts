// POST /api/servers/[id]/test used to call lib/ollama's getVersion
// unconditionally, hitting Ollama's /api/version. vLLM only serves /version,
// so testing a healthy vLLM endpoint reported it offline. The route must
// probe through the engine adapter so each engine is checked on its own
// version path.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: { endpoint: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(async () => ({ kind: "user", userId: "admin_1", role: "admin" })),
}));

import { prisma } from "@/lib/prisma";

const findUnique = () => prisma.endpoint.findUnique as ReturnType<typeof vi.fn>;
const realFetch = global.fetch;

function req() {
  return new NextRequest("http://localhost/api/servers/srv_1/test", { method: "POST" });
}

async function call() {
  const { POST } = await import("@/app/api/servers/[id]/test/route");
  return POST(req(), { params: Promise.resolve({ id: "srv_1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = realFetch;
});

const ollamaServer = {
  id: "srv_1",
  name: "local-ollama",
  url: "http://10.0.0.10:11434",
  engine: "ollama",
};

const vllmServer = {
  id: "srv_1",
  name: "spark-cluster",
  url: "http://10.0.0.20:8888",
  engine: "vllm",
};

describe("POST /api/servers/[id]/test", () => {
  it("reports an Ollama endpoint online with its version, unchanged response shape", async () => {
    findUnique().mockResolvedValue(ollamaServer);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: "0.5.1" }),
    }) as unknown as typeof fetch;

    const res = await call();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      status: "online",
      version: "0.5.1",
      url: "http://10.0.0.10:11434",
    });
  });

  it("reports an Ollama endpoint offline with an error message, unchanged response shape", async () => {
    findUnique().mockResolvedValue(ollamaServer);
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const res = await call();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe("offline");
    expect(data.error).toBe("Connection refused");
    expect(data.url).toBe("http://10.0.0.10:11434");
  });

  it("reports a healthy vLLM endpoint online, even though it 404s /api/version", async () => {
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/api/version")) {
        return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
      }
      if (url.endsWith("/version")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: "0.1.dev1+g53420169e.d20260724" }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const res = await call();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      status: "online",
      version: "0.1.dev1+g53420169e.d20260724",
      url: "http://10.0.0.20:8888",
    });
  });

  it("returns 403 when the caller is not an admin", async () => {
    const { requireAdminAuth } = await import("@/lib/require-auth");
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await call();
    expect(res.status).toBe(403);
  });
});
