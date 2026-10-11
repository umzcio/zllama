import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const userMock = {
    count: vi.fn(),
    create: vi.fn(),
  };
  return {
    prisma: {
      user: userMock,
      $transaction: vi.fn((callback: (tx: { user: typeof userMock }) => unknown) =>
        callback({ user: userMock })
      ),
    },
  };
});

vi.mock("@/lib/password", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed_password"),
}));

import { prisma } from "@/lib/prisma";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/setup/admin", () => {
  it("creates admin when no users exist", async () => {
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      username: "myadmin",
    });

    const { POST } = await import("@/app/api/setup/admin/route");
    const req = new Request("http://localhost/api/setup/admin", {
      method: "POST",
      body: JSON.stringify({ username: "myadmin", password: "securepass123" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.username).toBe("myadmin");
  });

  it("returns 409 when admin already exists", async () => {
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const { POST } = await import("@/app/api/setup/admin/route");
    const req = new Request("http://localhost/api/setup/admin", {
      method: "POST",
      body: JSON.stringify({ username: "myadmin", password: "securepass123" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(409);
  });

  it("returns 400 when username is too short", async () => {
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const { POST } = await import("@/app/api/setup/admin/route");
    const req = new Request("http://localhost/api/setup/admin", {
      method: "POST",
      body: JSON.stringify({ username: "ab", password: "securepass123" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it("returns 400 when password is too short", async () => {
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const { POST } = await import("@/app/api/setup/admin/route");
    const req = new Request("http://localhost/api/setup/admin", {
      method: "POST",
      body: JSON.stringify({ username: "myadmin", password: "short" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it("returns 409 and does not create a second admin when a race is won by another request between the initial check and the transaction", async () => {
    (prisma.user.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(0) // initial fast-path check
      .mockResolvedValueOnce(1); // re-check inside the transaction: another request already created the admin
    (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      username: "myadmin",
    });

    const { POST } = await import("@/app/api/setup/admin/route");
    const req = new Request("http://localhost/api/setup/admin", {
      method: "POST",
      body: JSON.stringify({ username: "myadmin", password: "securepass123" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(409);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("performs the count-and-create inside a single transaction", async () => {
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      username: "myadmin",
    });

    const { POST } = await import("@/app/api/setup/admin/route");
    const req = new Request("http://localhost/api/setup/admin", {
      method: "POST",
      body: JSON.stringify({ username: "myadmin", password: "securepass123" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(201);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
