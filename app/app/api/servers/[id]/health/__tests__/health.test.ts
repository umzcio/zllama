// GET /api/servers/[id]/health used to call lib/ollama's getVersion
// unconditionally, which requests Ollama's /api/version. vLLM serves its
// version at /version instead, so a correctly-configured vLLM endpoint 404'd,
// fell into the catch block, and was reported "offline" even though it was
// healthy. The route must go through the engine adapter so each engine is
// probed on its own version path.

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

function req() {
  return new NextRequest("http://localhost/api/servers/srv_1/health");
}

async function call() {
  const { GET } = await import("@/app/api/servers/[id]/health/route");
  return GET(req(), { params: Promise.resolve({ id: "srv_1" }) });
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

describe("GET /api/servers/[id]/health", () => {
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
    expect(data).toEqual({ id: "srv_1", status: "online", version: "0.5.1" });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.10:11434/api/version");
  });

  it("reports an Ollama endpoint offline when the probe fails, unchanged response shape", async () => {
    findUnique().mockResolvedValue(ollamaServer);
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const res = await call();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ id: "srv_1", status: "offline" });
  });

  // The regression test: vLLM serves /version (200) but has no /api/version
  // (404). Against the pre-fix code, which always hits /api/version via
  // lib/ollama's getVersion, this 404s, is caught, and the route reports
  // "offline" for a healthy server. This test fails on that code and passes
  // once the route is routed through the engine adapter.
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
      id: "srv_1",
      status: "online",
      version: "0.1.dev1+g53420169e.d20260724",
    });
  });

  it("reports a vLLM endpoint offline when even /version fails", async () => {
    findUnique().mockResolvedValue(vllmServer);
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const res = await call();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ id: "srv_1", status: "offline" });
  });

  it("returns 404 when the server does not exist", async () => {
    findUnique().mockResolvedValue(null);

    const res = await call();
    expect(res.status).toBe(404);
  });
});
