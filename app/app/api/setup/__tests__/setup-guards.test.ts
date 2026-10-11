import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ollama", () => ({
  getVersion: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getVersion } from "@/lib/ollama";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/setup/test-connection", () => {
  it("returns 403 and does not call getVersion when setup is already completed", async () => {
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "setup_completed",
      value: "true",
    });

    const { POST } = await import("@/app/api/setup/test-connection/route");
    const req = new NextRequest("http://localhost/api/setup/test-connection", {
      method: "POST",
      body: JSON.stringify({ url: "http://10.0.0.5:11434" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(getVersion).not.toHaveBeenCalled();
  });

  it("proceeds and calls getVersion when the setting row is absent", async () => {
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getVersion as ReturnType<typeof vi.fn>).mockResolvedValue({ version: "0.5.1" });

    const { POST } = await import("@/app/api/setup/test-connection/route");
    const req = new NextRequest("http://localhost/api/setup/test-connection", {
      method: "POST",
      body: JSON.stringify({ url: "http://10.0.0.5:11434" }),
    });
    const res = await POST(req);
    const data = await res.json();

    expect(getVersion).toHaveBeenCalledWith("http://10.0.0.5:11434");
    expect(data.status).toBe("online");
  });

  it("returns offline status during setup when the connection fails", async () => {
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getVersion as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));

    const { POST } = await import("@/app/api/setup/test-connection/route");
    const req = new NextRequest("http://localhost/api/setup/test-connection", {
      method: "POST",
      body: JSON.stringify({ url: "http://10.0.0.5:11434" }),
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.status).toBe("offline");
  });
});

describe("POST /api/setup/complete", () => {
  it("returns 403 and does not call upsert when setup is already completed", async () => {
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "setup_completed",
      value: "true",
    });

    const { POST } = await import("@/app/api/setup/complete/route");
    const res = await POST();

    expect(res.status).toBe(403);
    expect(prisma.settings.upsert).not.toHaveBeenCalled();
  });

  it("returns 200 and calls upsert once when the setting is absent", async () => {
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.settings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "setup_completed",
      value: "true",
    });

    const { POST } = await import("@/app/api/setup/complete/route");
    const res = await POST();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(prisma.settings.upsert).toHaveBeenCalledTimes(1);
  });
});
