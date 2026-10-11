import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/password", () => ({
  verifyPassword: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { resetRateLimit } from "@/lib/rate-limit";

const ACTIVE_USER = {
  id: "u-1",
  username: "test-user-alpha",
  password: "hashed-password",
  role: "user",
  active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

async function getAuthorize() {
  const { authOptions } = await import("@/lib/auth");
  const provider = authOptions.providers[0] as unknown as {
    options: { authorize: (credentials: { username: string; password: string }) => Promise<unknown> };
  };
  return provider.options.authorize;
}

describe("sign-in throttle (authorize)", () => {
  it("returns a user object on correct credentials", async () => {
    resetRateLimit("signin:test-user-alpha");
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ACTIVE_USER);
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const authorize = await getAuthorize();
    const result = await authorize({ username: "test-user-alpha", password: "correct-pw" });

    expect(result).toMatchObject({ id: "u-1", name: "test-user-alpha", role: "user" });
  });

  it("returns null on wrong password", async () => {
    resetRateLimit("signin:test-user-beta");
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ACTIVE_USER,
      username: "test-user-beta",
    });
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const authorize = await getAuthorize();
    const result = await authorize({ username: "test-user-beta", password: "wrong-pw" });

    expect(result).toBeNull();
  });

  it("short-circuits after 10 failed attempts without calling verifyPassword", async () => {
    const username = "test-user-gamma";
    resetRateLimit(`signin:${username}`);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ACTIVE_USER,
      username,
    });
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const authorize = await getAuthorize();

    for (let i = 0; i < 10; i++) {
      const result = await authorize({ username, password: "wrong-pw" });
      expect(result).toBeNull();
    }

    expect(verifyPassword).toHaveBeenCalledTimes(10);
    (verifyPassword as ReturnType<typeof vi.fn>).mockClear();

    const eleventh = await authorize({ username, password: "wrong-pw" });
    expect(eleventh).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("does not affect a different username's bucket", async () => {
    const exhausted = "test-user-delta";
    const unaffected = "test-user-epsilon";
    resetRateLimit(`signin:${exhausted}`);
    resetRateLimit(`signin:${unaffected}`);
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { username: string } }) => ({
        ...ACTIVE_USER,
        username: where.username,
      })
    );

    const authorize = await getAuthorize();

    for (let i = 0; i < 11; i++) {
      await authorize({ username: exhausted, password: "wrong-pw" });
    }

    (verifyPassword as ReturnType<typeof vi.fn>).mockClear();
    const result = await authorize({ username: unaffected, password: "wrong-pw" });

    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("resets the bucket on a successful sign-in", async () => {
    const username = "test-user-zeta";
    resetRateLimit(`signin:${username}`);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ACTIVE_USER,
      username,
    });

    const authorize = await getAuthorize();

    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      await authorize({ username, password: "wrong-pw" });
    }

    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const success = await authorize({ username, password: "correct-pw" });
    expect(success).toMatchObject({ id: "u-1" });

    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const afterSuccess = await authorize({ username, password: "wrong-pw" });
    expect(afterSuccess).toBeNull();
    expect(verifyPassword).toHaveBeenCalled();
  });

  it("returns null for an inactive user", async () => {
    const username = "test-user-eta";
    resetRateLimit(`signin:${username}`);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ACTIVE_USER,
      username,
      active: false,
    });
    (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const authorize = await getAuthorize();
    const result = await authorize({ username, password: "correct-pw" });

    expect(result).toBeNull();
  });
});
