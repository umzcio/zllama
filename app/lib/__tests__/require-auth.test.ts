import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/validate-api-key", () => ({
  validateApiKey: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { validateApiKey } from "@/lib/validate-api-key";

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/servers", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAuth", () => {
  const originalAuthDisabled = process.env.AUTH_DISABLED;

  afterEach(() => {
    if (originalAuthDisabled === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalAuthDisabled;
    }
  });

  it("returns a synthetic admin principal when AUTH_DISABLED=true, without touching the DB", async () => {
    process.env.AUTH_DISABLED = "true";
    const { requireAuth } = await import("@/lib/require-auth");
    const result = await requireAuth(makeReq());

    expect(result).toEqual({ kind: "user", userId: "dev", role: "admin" });
    expect(getServerSession).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns an apiKey principal for a valid API key", async () => {
    (validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
      keyId: "k1",
    });

    const { requireAuth } = await import("@/lib/require-auth");
    const result = await requireAuth(makeReq({ authorization: "Bearer zl-test" }));

    expect(result).toEqual({ kind: "apiKey", keyId: "k1" });
  });

  it("returns null for an invalid API key and never falls through to the session check", async () => {
    (validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false });

    const { requireAuth } = await import("@/lib/require-auth");
    const result = await requireAuth(makeReq({ authorization: "Bearer zl-test" }));

    expect(result).toBeNull();
    expect(getServerSession).not.toHaveBeenCalled();
  });

  it("returns a user principal with the DB role for a valid session and active DB user", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1", role: "admin" },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      role: "user",
    });

    const { requireAuth } = await import("@/lib/require-auth");
    const result = await requireAuth(makeReq());

    expect(result).toEqual({ kind: "user", userId: "u1", role: "user" });
  });

  it("returns null when the DB user is deactivated", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1", role: "admin" },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
      role: "admin",
    });

    const { requireAuth } = await import("@/lib/require-auth");
    const result = await requireAuth(makeReq());

    expect(result).toBeNull();
  });

  it("returns null when the DB user is missing", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1", role: "admin" },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { requireAuth } = await import("@/lib/require-auth");
    const result = await requireAuth(makeReq());

    expect(result).toBeNull();
  });
});

describe("requireAdminAuth", () => {
  it("returns null when the JWT-adjacent session claims admin but the DB says user (stale-JWT escalation blocked)", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1", role: "admin" },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      role: "user",
    });

    const { requireAdminAuth } = await import("@/lib/require-auth");
    const result = await requireAdminAuth(makeReq());

    expect(result).toBeNull();
  });

  it("returns null for a valid API key — an API key never satisfies admin auth", async () => {
    (validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
      keyId: "k1",
    });

    const { requireAdminAuth } = await import("@/lib/require-auth");
    const result = await requireAdminAuth(makeReq({ authorization: "Bearer zl-test" }));

    expect(result).toBeNull();
  });
});
