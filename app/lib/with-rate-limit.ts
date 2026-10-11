import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

export function getRateLimitKey(req: NextRequest): string {
  // X-Forwarded-For is client-controlled unless a trusted reverse proxy
  // overwrites it. Only honor it when the operator has confirmed that proxy
  // is in place; otherwise a caller could vary the header on every request
  // and never hit the same bucket twice.
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const forwarded = req.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim();
    if (ip) return `ip:${ip}`;
  }

  const realIp = req.headers.get("x-real-ip");
  return `ip:${realIp || "unknown"}`;
}

export function withRateLimit(
  handler: (req: NextRequest, ctx: any) => Promise<Response>
) {
  return async (req: NextRequest, ctx: any) => {
    const key = getRateLimitKey(req);
    const result = checkRateLimit(key);

    if (!result.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(result.resetMs / 1000)),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(result.resetMs),
          },
        }
      );
    }

    const response = await handler(req, ctx);

    const headers = new Headers(response.headers);
    headers.set("X-RateLimit-Remaining", String(result.remaining));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
