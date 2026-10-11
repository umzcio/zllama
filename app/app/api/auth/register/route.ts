export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { checkRateLimit } from "@/lib/rate-limit";

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

async function isRegistrationEnabled(): Promise<boolean> {
  const setting = await prisma.settings.findUnique({
    where: { key: "allowRegistration" },
  });
  return setting?.value === "true";
}

export async function GET() {
  const enabled = await isRegistrationEnabled();
  return NextResponse.json({ enabled });
}

export async function POST(req: NextRequest) {
  if (!(await isRegistrationEnabled())) {
    return NextResponse.json(
      { error: "Registration is disabled" },
      { status: 403 }
    );
  }

  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  // Fixed policy independent of the admin-tunable proxy rate limit.
  const rate = checkRateLimit(`register:${ip}`, { maxRequests: 10, windowMs: 60_000 });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.resetMs / 1000)) },
      }
    );
  }

  const body = await req.json();
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (
    username.length < 3 ||
    username.length > 32 ||
    !USERNAME_PATTERN.test(username)
  ) {
    return NextResponse.json(
      { error: "Username must be 3-32 characters (letters, numbers, . _ -)" },
      { status: 400 }
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json(
      { error: "Username already exists" },
      { status: 409 }
    );
  }

  const hashed = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      username,
      password: hashed,
      role: "user",
      active: true,
    },
    select: { id: true, username: true },
  });

  return NextResponse.json(user, { status: 201 });
}
