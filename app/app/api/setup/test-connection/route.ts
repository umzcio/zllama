import { NextRequest, NextResponse } from "next/server";
import { getVersion } from "@/lib/ollama";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  // Only allow during setup
  const setting = await prisma.settings.findUnique({
    where: { key: "setup_completed" },
  });
  if (setting?.value === "true") {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  const { url } = await req.json();

  if (!url) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  try {
    const version = await getVersion(url);
    return NextResponse.json({ status: "online", version: version.version });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({ status: "offline", error: message });
  }
}
