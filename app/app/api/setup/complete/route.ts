import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
  // Only allow during setup
  const setting = await prisma.settings.findUnique({
    where: { key: "setup_completed" },
  });
  if (setting?.value === "true") {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  await prisma.settings.upsert({
    where: { key: "setup_completed" },
    update: { value: "true" },
    create: { key: "setup_completed", value: "true" },
  });

  return NextResponse.json({ ok: true });
}
