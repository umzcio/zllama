export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/require-auth";
import { parseDeclaration } from "@/lib/desired-state";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }
  return NextResponse.json(role);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const target = await prisma.role.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }

  const body = await req.json();
  const { name, description, desiredState } = body;

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const existing = await prisma.role.findUnique({ where: { name: name.trim() } });
    if (existing && existing.id !== id) {
      return NextResponse.json({ error: "Role name already exists" }, { status: 409 });
    }
  }

  let raw: string | undefined;
  if (desiredState !== undefined) {
    if (typeof desiredState !== "string") {
      return NextResponse.json(
        { error: "Invalid declaration: desiredState must be a JSON string" },
        { status: 400 }
      );
    }
    try {
      parseDeclaration(desiredState);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid declaration";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    raw = desiredState;
  }

  const role = await prisma.role.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(raw !== undefined && { desiredState: raw }),
    },
  });

  return NextResponse.json(role);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requireAdminAuth(req);
  if (!principal) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  try {
    await prisma.role.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }
}
