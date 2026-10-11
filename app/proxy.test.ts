import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getToken } from "next-auth/jwt";

function mockSetupFetch(completed: boolean) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ completed }),
  }) as unknown as typeof fetch;
}

async function loadProxy() {
  const mod = await import("@/proxy");
  return mod.proxy;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mockSetupFetch(true);
});

describe("proxy - public and setup paths", () => {
  it("passes through /api/health and sets Cache-Control: no-store", async () => {
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/health");
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes through /api/auth/session", async () => {
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/auth/session");
    const res = await proxy(req);

    expect(res.status).toBe(200);
  });

  it("passes through /api/setup/status", async () => {
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/setup/status");
    const res = await proxy(req);

    expect(res.status).toBe(200);
  });

  it("passes through /setup without a token", async () => {
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/setup");
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("passes through /auth/signin without a token", async () => {
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/auth/signin");
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("redirects to /setup when setup is not completed", async () => {
    mockSetupFetch(false);
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/");
    const res = await proxy(req);

    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(new URL(location!).pathname.endsWith("/setup")).toBe(true);
  });
});

describe("proxy - session gating", () => {
  it("returns 401 with a JSON body for an unauthenticated API request", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/servers");
    const res = await proxy(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data).toEqual({ error: "Unauthorized" });
  });

  it("redirects an unauthenticated page request to /auth/signin with callbackUrl", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/");
    const res = await proxy(req);

    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.pathname).toBe("/auth/signin");
    expect(url.searchParams.get("callbackUrl")).toBe("/");
  });

  it("treats a revoked token as unauthenticated (401)", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      role: "user",
      revoked: true,
    });
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/servers");
    const res = await proxy(req);

    expect(res.status).toBe(401);
  });
});

describe("proxy - admin gate", () => {
  it("redirects a non-admin to / for /api/admin/models", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "user" });
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/admin/models");
    const res = await proxy(req);

    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(new URL(location!).pathname).toBe("/");
  });

  it("redirects a non-admin to / for /api/users", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "user" });
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/users");
    const res = await proxy(req);

    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(new URL(location!).pathname).toBe("/");
  });

  it("passes through /api/users/me/password for a non-admin (self-service exemption)", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "user" });
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/users/me/password");
    const res = await proxy(req);

    expect(res.status).toBe(200);
  });

  it("passes through /api/admin/models for an admin", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "admin" });
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/admin/models");
    const res = await proxy(req);

    expect(res.status).toBe(200);
  });

  it("passes through /api/dashboard for a non-admin authenticated user", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "user" });
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/dashboard");
    const res = await proxy(req);

    expect(res.status).toBe(200);
  });
});

describe("proxy - API key scope", () => {
  it("returns 401 for an unrecognized API key against /api/servers", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/servers", {
      headers: { authorization: "Bearer zl-not-a-real-key" },
    });
    const res = await proxy(req);

    expect(res.status).toBe(401);
  });

  it("returns 401 for an unrecognized API key against /api/admin/models/delete", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/admin/models/delete", {
      headers: { authorization: "Bearer zl-not-a-real-key" },
    });
    const res = await proxy(req);

    expect(res.status).toBe(401);
  });

  it("returns 401 for an unrecognized API key against /api/logs", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/logs", {
      headers: { authorization: "Bearer zl-not-a-real-key" },
    });
    const res = await proxy(req);

    expect(res.status).toBe(401);
  });

  it("passes an API key through to the gateway, which validates it itself", async () => {
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/proxy/api/tags", {
      headers: { authorization: "Bearer zl-not-a-real-key" },
    });
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("returns 401 for the legacy oa- prefix against /api/servers (no special treatment)", async () => {
    (getToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/servers", {
      headers: { authorization: "Bearer oa-legacy-style" },
    });
    const res = await proxy(req);

    expect(res.status).toBe(401);
  });
});

describe("proxy - dev bypass", () => {
  const originalAuthDisabled = process.env.AUTH_DISABLED;

  afterEach(() => {
    if (originalAuthDisabled === undefined) {
      delete process.env.AUTH_DISABLED;
    } else {
      process.env.AUTH_DISABLED = originalAuthDisabled;
    }
  });

  it("bypasses auth entirely when AUTH_DISABLED=true, without calling getToken", async () => {
    process.env.AUTH_DISABLED = "true";
    const proxy = await loadProxy();
    const req = new NextRequest("http://localhost/api/servers");
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });
});
