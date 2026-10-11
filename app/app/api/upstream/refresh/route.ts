export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/require-auth";
import { getLatestOllamaVersion } from "@/lib/upstream";

export async function POST(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ollama = await getLatestOllamaVersion(true);
  return NextResponse.json({ ollama });
}
