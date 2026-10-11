import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/password", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed_password"),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 59, resetMs: 1000 })),
}));

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

const mockUser = { id: "u1", username: "newuser" };

function enableRegistration(enabled: boolean) {
  (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
    enabled ? { key: "allowRegistration", value: "true" } : null
  );
}

function postReq(body: unknown) {
  return new Request("http://localhost/api/auth/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (checkRateLimit as ReturnType<typeof vi.fn>).mockReturnValue({
    allowed: true,
    remaining: 59,
    resetMs: 1000,
  });
});

describe("GET /api/auth/register", () => {
  it("returns enabled true when setting is 'true'", async () => {
    enableRegistration(true);
    const { GET } = await import("@/app/api/auth/register/route");
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual({ enabled: true });
  });

  it("returns enabled false when setting is absent", async () => {
    enableRegistration(false);
    const { GET } = await import("@/app/api/auth/register/route");
    const res = await GET();
    const data = await res.json();
    expect(data).toEqual({ enabled: false });
  });

  it("returns enabled false when setting is not 'true'", async () => {
    (prisma.settings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "allowRegistration",
      value: "false",
    });
    const { GET } = await import("@/app/api/auth/register/route");
    const res = await GET();
    const data = await res.json();
    expect(data).toEqual({ enabled: false });
  });
});

describe("POST /api/auth/register", () => {
  it("returns 403 when registration is disabled", async () => {
    enableRegistration(false);
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      postReq({ username: "newuser", password: "securepass123" }) as any
    );
    expect(res.status).toBe(403);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("creates a user and returns 201 with id/username only", async () => {
    enableRegistration(true);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);

    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      postReq({ username: "newuser", password: "securepass123" }) as any
    );
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data).toEqual({ id: "u1", username: "newuser" });
    expect(data.password).toBeUndefined();
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "user", active: true }),
      })
    );
  });

  it("returns 409 when username already exists", async () => {
    enableRegistration(true);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "existing",
      username: "newuser",
    });

    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      postReq({ username: "newuser", password: "securepass123" }) as any
    );
    expect(res.status).toBe(409);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("returns 400 when username is too short", async () => {
    enableRegistration(true);
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      postReq({ username: "ab", password: "securepass123" }) as any
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when username has invalid characters", async () => {
    enableRegistration(true);
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      postReq({ username: "bad name!", password: "securepass123" }) as any
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is too short", async () => {
    enableRegistration(true);
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      postReq({ username: "newuser", password: "short" }) as any
    );
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    enableRegistration(true);
    (checkRateLimit as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      remaining: 0,
      resetMs: 5000,
    });

    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(
      postReq({ username: "newuser", password: "securepass123" }) as any
    );
    expect(res.status).toBe(429);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
