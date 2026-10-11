import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

let setupCompleted = false;
let setupCheckedAt = 0;

function withNoCache(res: NextResponse, path: string): NextResponse {
  if (path.startsWith("/api/")) {
    res.headers.set("Cache-Control", "no-store");
  }
  return res;
}

export async function proxy(req: NextRequest) {
  const start = Date.now();
  const { method } = req;
  const path = req.nextUrl.pathname;

  // Always allow static assets, auth endpoints, setup, health check
  const publicPaths = [
    "/api/auth",
    "/api/setup",
    "/api/health",
    "/api/agent",
    "/_next",
    "/favicon.ico",
  ];
  if (publicPaths.some((p) => path.startsWith(p))) {
    const res = withNoCache(NextResponse.next(), path);
    logRequest(method, path, res.status, Date.now() - start);
    return res;
  }

  // Allow setup and auth pages without token
  if (path.startsWith("/setup") || path.startsWith("/auth")) {
    const res = NextResponse.next();
    logRequest(method, path, res.status, Date.now() - start);
    return res;
  }

  // Check if setup is completed — redirect to /setup if not (cached 60s).
  // Target the local server, never req.nextUrl: behind an edge auth layer
  // (e.g. an identity-aware proxy) a self-fetch to the public host returns the login
  // page instead of JSON, which would pin setupCompleted to false forever.
  if (!setupCompleted || Date.now() - setupCheckedAt > 60_000) {
    try {
      const origin = process.env.INTERNAL_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`;
      const statusUrl = `${origin}/api/setup/status`;
      const statusRes = await fetch(statusUrl, { cache: "no-store" });
      if (statusRes.ok) {
        const data = await statusRes.json();
        setupCompleted = !!data.completed;
        setupCheckedAt = Date.now();
      }
    } catch {
      // If status check fails, continue normally
    }
  }

  if (!setupCompleted) {
    logRequest(method, path, 302, Date.now() - start, "setup-redirect");
    const setupUrl = req.nextUrl.clone();
    setupUrl.pathname = "/setup";
    setupUrl.search = "";
    return NextResponse.redirect(setupUrl);
  }

  // Dev bypass — opt-in to disable auth for local development
  if (process.env.AUTH_DISABLED === "true") {
    const res = withNoCache(NextResponse.next(), path);
    logRequest(method, path, res.status, Date.now() - start);
    return res;
  }

  // API keys authenticate the Ollama gateway only, and the gateway route
  // validates the key itself. Every other route requires a session.
  const authHeader = req.headers.get("authorization");
  const hasApiKey =
    !!authHeader &&
    (authHeader.startsWith("Bearer zl-") || authHeader.startsWith("Bearer oa-"));

  if (hasApiKey && path.startsWith("/api/proxy/")) {
    const res = withNoCache(NextResponse.next(), path);
    logRequest(method, path, res.status, Date.now() - start, "api-key");
    return res;
  }

  // Require authentication for everything else
  let token = null;
  try {
    token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  } catch {
    token = null;
  }
  if (!token || token.revoked === true) {
    if (path.startsWith("/api/")) {
      logRequest(method, path, 401, Date.now() - start, "unauthorized");
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const signInUrl = req.nextUrl.clone();
    signInUrl.pathname = "/auth/signin";
    signInUrl.search = "";
    signInUrl.searchParams.set("callbackUrl", path);
    logRequest(method, path, 302, Date.now() - start, "auth-redirect");
    return NextResponse.redirect(signInUrl);
  }

  // Admin-only routes
  const isAdminOnly =
    path.startsWith("/admin/") ||
    path.startsWith("/api/admin/") ||
    // /api/users/me/* is self-service (any authenticated user); the rest of
    // /api/users is admin-only user management.
    (path.startsWith("/api/users") && !path.startsWith("/api/users/me")) ||
    path.startsWith("/api/api-keys") ||
    path.startsWith("/discover") ||
    path.startsWith("/api/catalog");
  if (isAdminOnly && token?.role !== "admin") {
    logRequest(method, path, 403, Date.now() - start, "forbidden");
    const homeUrl = req.nextUrl.clone();
    homeUrl.pathname = "/";
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  const res = withNoCache(NextResponse.next(), path);
  logRequest(method, path, res.status, Date.now() - start);
  return res;
}

function logRequest(method: string, path: string, status: number, ms: number, note?: string) {
  if (path.startsWith("/_next")) return;
  const extra = note ? ` (${note})` : "";
  console.log(`${new Date().toISOString()} [HTTP] ${method} ${path} ${status} ${ms}ms${extra}`);
}

export const config = {
  matcher: [
    "/",
    "/api/:path*",
    "/admin/:path*",
    "/auth/:path*",
    "/discover",
    "/discover/:path*",
    "/gpu",
    "/gpu/:path*",
    "/settings",
    "/settings/:path*",
    "/setup",
    "/setup/:path*",
    "/tools",
    "/tools/:path*",
  ],
};
