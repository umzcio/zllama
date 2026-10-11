import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getRateLimitKey, withRateLimit } from "@/lib/with-rate-limit";
import * as rateLimitModule from "@/lib/rate-limit";

const ORIGINAL_TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_TRUST_PROXY_HEADERS === undefined) {
    delete process.env.TRUST_PROXY_HEADERS;
  } else {
    process.env.TRUST_PROXY_HEADERS = ORIGINAL_TRUST_PROXY_HEADERS;
  }
});

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/proxy/tags", { headers });
}

describe("getRateLimitKey", () => {
  it("trust disabled: ignores x-forwarded-for", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const req = makeRequest({ "x-forwarded-for": "192.168.1.50" });
    const key = getRateLimitKey(req);
    expect(key).not.toContain("192.168.1.50");
  });

  it("trust disabled: falls back to x-real-ip", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const req = makeRequest({ "x-real-ip": "10.0.0.5" });
    expect(getRateLimitKey(req)).toBe("ip:10.0.0.5");
  });

  it("trust disabled: falls back to unknown with no headers", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const req = makeRequest({});
    expect(getRateLimitKey(req)).toBe("ip:unknown");
  });

  it("trust enabled: uses first entry of x-forwarded-for", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const req = makeRequest({ "x-forwarded-for": "10.1.2.3, 10.9.9.9" });
    expect(getRateLimitKey(req)).toBe("ip:10.1.2.3");
  });

  it("trust enabled: falls back to x-real-ip when forwarded header is absent", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const req = makeRequest({ "x-real-ip": "192.168.0.9" });
    expect(getRateLimitKey(req)).toBe("ip:192.168.0.9");
  });
});

describe("withRateLimit", () => {
  it("returns 429 with Retry-After and does not call the handler when blocked", async () => {
    vi.spyOn(rateLimitModule, "checkRateLimit").mockReturnValue({
      allowed: false,
      remaining: 0,
      resetMs: 5000,
    });

    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = withRateLimit(handler);
    const req = makeRequest({});

    const res = await wrapped(req, {});

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes through the handler's response and sets X-RateLimit-Remaining when allowed", async () => {
    vi.spyOn(rateLimitModule, "checkRateLimit").mockReturnValue({
      allowed: true,
      remaining: 42,
      resetMs: 1000,
    });

    const handler = vi.fn(
      async () => new Response(JSON.stringify({ hello: "world" }), { status: 201 })
    );
    const wrapped = withRateLimit(handler);
    const req = makeRequest({});

    const res = await wrapped(req, {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("42");
    expect(await res.text()).toBe(JSON.stringify({ hello: "world" }));
  });
});
