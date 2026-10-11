export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { roleId, converge } = body;

  const data: { roleId?: string | null; converge?: boolean } = {};

  if (roleId !== undefined) {
    if (roleId !== null) {
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return NextResponse.json({ error: "Unknown role" }, { status: 400 });
      }
    }
    data.roleId = roleId;
  }

  if (converge !== undefined) {
    if (typeof converge !== "boolean") {
      return NextResponse.json({ error: "converge must be a boolean" }, { status: 400 });
    }
    data.converge = converge;
  }

  try {
    const host = await prisma.host.update({
      where: { id },
      data,
    });
    return NextResponse.json(host);
  } catch {
    return NextResponse.json({ error: "Host not found" }, { status: 404 });
  }
}
