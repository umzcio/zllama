import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/require-admin", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/system-settings", () => ({
  invalidateSystemSettings: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { invalidateSystemSettings } from "@/lib/system-settings";

const mockSession = { user: { id: "admin_1", name: "admin", role: "admin" } };

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
});

describe("GET /api/settings", () => {
  it("returns all settings as key-value object", async () => {
    (prisma.settings.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: "logRetentionDays", value: "90" },
      { key: "logStorePrompts", value: "true" },
    ]);

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const data = await res.json();

    expect(data).toEqual({
      logRetentionDays: "90",
      logStorePrompts: "true",
    });
  });

  it("returns empty object when no settings", async () => {
    (prisma.settings.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      []
    );

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const data = await res.json();

    expect(data).toEqual({});
  });
});

describe("PUT /api/settings", () => {
  it("upserts allowed settings and invalidates the cache", async () => {
    (prisma.settings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        allowRegistration: "true",
        logRetentionDays: "30",
      }),
    });
    const res = await PUT(req as any);
    const data = await res.json();

    expect(data).toEqual({ ok: true });
    expect(prisma.settings.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.settings.upsert).toHaveBeenCalledWith({
      where: { key: "logRetentionDays" },
      update: { value: "30" },
      create: { key: "logRetentionDays", value: "30" },
    });
    expect(prisma.settings.upsert).toHaveBeenCalledWith({
      where: { key: "allowRegistration" },
      update: { value: "true" },
      create: { key: "allowRegistration", value: "true" },
    });
    expect(invalidateSystemSettings).toHaveBeenCalledTimes(1);
  });

  it("ignores logStorePrompts and other unknown keys", async () => {
    (prisma.settings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        logStorePrompts: "false",
        setup_completed: "false",
        rateLimitMax: "120",
      }),
    });
    const res = await PUT(req as any);

    expect(res.status).toBe(200);
    expect(prisma.settings.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.settings.upsert).toHaveBeenCalledWith({
      where: { key: "rateLimitMax" },
      update: { value: "120" },
      create: { key: "rateLimitMax", value: "120" },
    });
  });

  it("coerces a non-boolean allowRegistration to 'false'", async () => {
    (prisma.settings.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({ allowRegistration: "yes" }),
    });
    await PUT(req as any);

    expect(prisma.settings.upsert).toHaveBeenCalledWith({
      where: { key: "allowRegistration" },
      update: { value: "false" },
      create: { key: "allowRegistration", value: "false" },
    });
  });

  it("returns 403 when not admin", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({ logRetentionDays: "30" }),
    });
    const res = await PUT(req as any);

    expect(res.status).toBe(403);
  });
});
