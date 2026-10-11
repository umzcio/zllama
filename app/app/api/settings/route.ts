export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { invalidateSystemSettings } from "@/lib/system-settings";

const ALLOWED_KEYS = new Set([
  "allowRegistration",
  "logRetentionDays",
  "rateLimitMax",
  "rateLimitWindow",
]);

export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const settings = await prisma.settings.findMany();
  const result: Record<string, string> = {};
  for (const s of settings) {
    result[s.key] = s.value;
  }
  return NextResponse.json(result);
}

export async function PUT(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const data = await req.json();

  for (const [key, rawValue] of Object.entries(data)) {
    if (!ALLOWED_KEYS.has(key)) continue;

    let value = String(rawValue);
    if (key === "allowRegistration") {
      value = value === "true" ? "true" : "false";
    }

    await prisma.settings.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  invalidateSystemSettings();

  return NextResponse.json({ ok: true });
}
