export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

export async function GET(req: NextRequest) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const hosts = await prisma.host.findMany({
    include: { gpus: true, runtimes: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(hosts);
}
