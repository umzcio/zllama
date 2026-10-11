export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const host = await prisma.host.update({
      where: { id },
      data: { approvalState: "approved" },
    });
    return NextResponse.json(host);
  } catch {
    return NextResponse.json({ error: "Host not found" }, { status: 404 });
  }
}
