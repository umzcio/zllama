import { NextRequest, NextResponse } from "next/server";
import { pullManager } from "@/lib/pull-manager";
import { requireAuth } from "@/lib/require-auth";

export async function GET(req: NextRequest) {
  const principal = await requireAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serverId = req.nextUrl.searchParams.get("serverId") || undefined;
  const jobs = pullManager.getStatus(serverId);
  return NextResponse.json(jobs);
}
