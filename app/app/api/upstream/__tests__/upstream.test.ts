import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/require-auth", () => ({
  requireAdminAuth: vi.fn(),
}));

vi.mock("@/lib/upstream", () => ({
  getLatestOllamaVersion: vi.fn(),
}));

import { requireAdminAuth } from "@/lib/require-auth";
import { getLatestOllamaVersion } from "@/lib/upstream";

const mockRelease = {
  latest: "0.33.0",
  htmlUrl: "https://github.com/ollama/ollama/releases/tag/v0.33.0",
  publishedAt: "2026-01-01T00:00:00Z",
  checkedAt: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/upstream", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { GET } = await import("@/app/api/upstream/route");
    const res = await GET(new NextRequest("http://localhost/api/upstream"));
    expect(res.status).toBe(403);
    expect(getLatestOllamaVersion).not.toHaveBeenCalled();
  });

  it("returns the ollama release under an `ollama` key for an admin", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "user",
      userId: "admin_1",
      role: "admin",
    });
    (getLatestOllamaVersion as ReturnType<typeof vi.fn>).mockResolvedValue(mockRelease);

    const { GET } = await import("@/app/api/upstream/route");
    const res = await GET(new NextRequest("http://localhost/api/upstream"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ollama: mockRelease });
    expect(getLatestOllamaVersion).toHaveBeenCalledWith();
  });

  it("returns { ollama: null } when nothing is known upstream", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "user",
      userId: "admin_1",
      role: "admin",
    });
    (getLatestOllamaVersion as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/upstream/route");
    const res = await GET(new NextRequest("http://localhost/api/upstream"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ollama: null });
  });
});

describe("POST /api/upstream/refresh", () => {
  it("requires admin auth", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { POST } = await import("@/app/api/upstream/refresh/route");
    const res = await POST(new NextRequest("http://localhost/api/upstream/refresh", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(getLatestOllamaVersion).not.toHaveBeenCalled();
  });

  it("forces the check for an admin", async () => {
    (requireAdminAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "user",
      userId: "admin_1",
      role: "admin",
    });
    (getLatestOllamaVersion as ReturnType<typeof vi.fn>).mockResolvedValue(mockRelease);

    const { POST } = await import("@/app/api/upstream/refresh/route");
    const res = await POST(new NextRequest("http://localhost/api/upstream/refresh", { method: "POST" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ollama: mockRelease });
    expect(getLatestOllamaVersion).toHaveBeenCalledWith(true);
  });
});
