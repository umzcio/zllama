import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAdmin", () => {
  it("returns session when user is an active admin in the DB", async () => {
    const session = { user: { id: "u1", role: "admin" } };
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      role: "admin",
    });

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toEqual(session);
  });

  it("returns null when user is not admin", async () => {
    const session = { user: { id: "u1", role: "user" } };
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toBeNull();
  });

  it("returns null when no session", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toBeNull();
  });

  it("returns null when the DB user no longer exists (revoked)", async () => {
    const session = { user: { id: "u1", role: "admin" } };
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toBeNull();
  });

  it("returns null when the DB user is deactivated (revoked)", async () => {
    const session = { user: { id: "u1", role: "admin" } };
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
      role: "admin",
    });

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toBeNull();
  });

  it("returns null when the DB user was demoted (stale JWT)", async () => {
    const session = { user: { id: "u1", role: "admin" } };
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      role: "user",
    });

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toBeNull();
  });
});
