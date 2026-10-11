import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/password", () => ({
  hashPassword: vi.fn().mockResolvedValue("new_hashed"),
  verifyPassword: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { verifyPassword } from "@/lib/password";

const activeUser = {
  id: "u1",
  username: "alice",
  password: "current_hash",
  role: "user",
  active: true,
};

const session = { user: { id: "u1", role: "user" } };

function makeReq(body: unknown) {
  return new Request("http://localhost/api/users/me/password", {
    method: "POST",
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/users/me/password", () => {
  it("returns 401 when there is no session", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { POST } = await import("@/app/api/users/me/password/route");
    const res = await POST(makeReq({ currentPassword: "x", newPassword: "longenough" }));

    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 401 when the user is inactive", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...activeUser,
      active: false,
    });

    const { POST } = await import("@/app/api/users/me/password/route");
    const res = await POST(makeReq({ currentPassword: "x", newPassword: "longenough" }));

    expect(res.status).toBe(401);
  });

  it("returns 400 when the new password is too short", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(activeUser);

    const { POST } = await import("@/app/api/users/me/password/route");
    const res = await POST(makeReq({ currentPassword: "current", newPassword: "short" }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("weakPassword");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 400 when the current password is wrong", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(activeUser);
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { POST } = await import("@/app/api/users/me/password/route");
    const res = await POST(makeReq({ currentPassword: "wrong", newPassword: "longenough" }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("wrongCurrentPassword");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("updates the password hash on success", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(activeUser);
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue(activeUser);

    const { POST } = await import("@/app/api/users/me/password/route");
    const res = await POST(makeReq({ currentPassword: "current", newPassword: "longenough" }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { password: "new_hashed" },
    });
  });
});
