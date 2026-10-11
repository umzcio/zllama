// The engine capability matrix has to be consulted, not merely declared.
//
// vLLM's adapter declares pullModel/deleteModel/copyModel/showModel all
// false, but all four admin model routes imported `@/lib/ollama` directly
// with no engine check, so they fired Ollama API calls at vLLM endpoints and
// the operator got a confusing upstream failure instead of a clear refusal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: { endpoint: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(async () => ({ kind: "user", userId: "admin_1", role: "admin" })),
  requireAuth: vi.fn(async () => ({ kind: "user", userId: "admin_1", role: "admin" })),
}));

vi.mock("@/lib/require-admin", () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: "admin_1", role: "admin" } })),
}));

vi.mock("@/lib/ollama", () => ({
  deleteModel: vi.fn(async () => ({})),
  copyModel: vi.fn(async () => ({})),
  showModel: vi.fn(async () => ({ details: {} })),
}));

vi.mock("@/lib/pull-manager", () => ({
  pullManager: {
    startPull: vi.fn(() => ({ id: "job_1", model: "qwen3", tag: "32b", status: "pending" })),
  },
}));

import { prisma } from "@/lib/prisma";
import { deleteModel, copyModel, showModel } from "@/lib/ollama";
import { pullManager } from "@/lib/pull-manager";

const findUnique = () => prisma.endpoint.findUnique as ReturnType<typeof vi.fn>;

const ollamaEndpoint = {
  id: "ep_ollama",
  name: "ollama-node",
  url: "http://10.0.0.10:11434",
  engine: "ollama",
  active: true,
};

const vllmEndpoint = {
  id: "ep_vllm",
  name: "spark-cluster",
  url: "http://10.0.0.20:8888",
  engine: "vllm",
  active: true,
};

function jsonReq(url: string, method: string, body: unknown) {
  return new NextRequest(url, { method, body: JSON.stringify(body) });
}

interface RouteCase {
  label: string;
  capability: string;
  call: () => Promise<Response>;
  spy: () => ReturnType<typeof vi.fn>;
  okStatus: number;
}

const cases: RouteCase[] = [
  {
    label: "DELETE /api/admin/models/delete",
    capability: "deleteModel",
    call: async () => {
      const { DELETE } = await import("@/app/api/admin/models/delete/route");
      return DELETE(
        jsonReq("http://localhost/api/admin/models/delete", "DELETE", {
          serverId: "x",
          name: "qwen3:32b",
        })
      );
    },
    spy: () => deleteModel as ReturnType<typeof vi.fn>,
    okStatus: 200,
  },
  {
    label: "POST /api/admin/models/copy",
    capability: "copyModel",
    call: async () => {
      const { POST } = await import("@/app/api/admin/models/copy/route");
      return POST(
        jsonReq("http://localhost/api/admin/models/copy", "POST", {
          serverId: "x",
          source: "qwen3:32b",
          destination: "qwen3:mine",
        })
      );
    },
    spy: () => copyModel as ReturnType<typeof vi.fn>,
    okStatus: 200,
  },
  {
    label: "POST /api/admin/models/show",
    capability: "showModel",
    call: async () => {
      const { POST } = await import("@/app/api/admin/models/show/route");
      return POST(
        jsonReq("http://localhost/api/admin/models/show", "POST", {
          serverId: "x",
          name: "qwen3:32b",
        })
      );
    },
    spy: () => showModel as ReturnType<typeof vi.fn>,
    okStatus: 200,
  },
  {
    label: "POST /api/admin/models/pull",
    capability: "pullModel",
    call: async () => {
      const { POST } = await import("@/app/api/admin/models/pull/route");
      return POST(
        jsonReq("http://localhost/api/admin/models/pull", "POST", {
          serverId: "x",
          name: "qwen3:32b",
        })
      );
    },
    spy: () => pullManager.startPull as ReturnType<typeof vi.fn>,
    okStatus: 202,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("admin model routes honor the engine capability matrix", () => {
  for (const routeCase of cases) {
    it(`${routeCase.label} refuses a vLLM endpoint with 400, naming the engine`, async () => {
      findUnique().mockResolvedValue(vllmEndpoint);

      const res = await routeCase.call();
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/vllm/i);
      // Actionable, not just a refusal: the operator is told where the
      // operation does belong.
      expect(data.error).toMatch(/role/i);
      // And no Ollama API call was ever made at the vLLM endpoint.
      expect(routeCase.spy()).not.toHaveBeenCalled();
    });

    it(`${routeCase.label} still works against an Ollama endpoint`, async () => {
      findUnique().mockResolvedValue(ollamaEndpoint);

      const res = await routeCase.call();

      expect(res.status).toBe(routeCase.okStatus);
      expect(routeCase.spy()).toHaveBeenCalled();
    });

    it(`${routeCase.label} refuses an unrecognized engine rather than assuming Ollama`, async () => {
      findUnique().mockResolvedValue({ ...ollamaEndpoint, engine: "mystery" });

      const res = await routeCase.call();
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/mystery/);
      expect(routeCase.spy()).not.toHaveBeenCalled();
    });
  }
});
