import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { requireAdmin } from "@/lib/require-admin";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "notFound" }, { status: 404 });
  }

  const { username, password, role, active } = await req.json();

  if (role !== undefined && role !== "admin" && role !== "user") {
    return NextResponse.json({ error: "invalidRole" }, { status: 400 });
  }

  const newRole = role !== undefined ? role : target.role;
  const newActive = active !== undefined ? active : target.active;
  const isSelf = session.user.id === id;

  if (isSelf && newRole !== "admin") {
    return NextResponse.json({ error: "cannotDemoteSelf" }, { status: 400 });
  }
  if (isSelf && newActive === false) {
    return NextResponse.json({ error: "cannotDeactivateSelf" }, { status: 400 });
  }

  const wasActiveAdmin = target.role === "admin" && target.active;
  const willBeActiveAdmin = newRole === "admin" && newActive === true;
  if (wasActiveAdmin && !willBeActiveAdmin) {
    const otherActiveAdmins = await prisma.user.count({
      where: { role: "admin", active: true, id: { not: id } },
    });
    if (otherActiveAdmins === 0) {
      return NextResponse.json({ error: "lastActiveAdmin" }, { status: 400 });
    }
  }

  const data: Record<string, unknown> = {};

  if (username !== undefined) {
    const trimmed = String(username).trim();
    if (
      trimmed.length < 3 ||
      trimmed.length > 32 ||
      !/^[a-zA-Z0-9_.-]+$/.test(trimmed)
    ) {
      return NextResponse.json({ error: "invalidUsername" }, { status: 400 });
    }
    const existing = await prisma.user.findUnique({ where: { username: trimmed } });
    if (existing && existing.id !== id) {
      return NextResponse.json({ error: "usernameExists" }, { status: 409 });
    }
    data.username = trimmed;
  }

  if (role !== undefined) data.role = role;
  if (active !== undefined) data.active = active;
  if (password && password.length >= 8) {
    data.password = await hashPassword(password);
  }

  const user = await prisma.user.update({
    where: { id: id },
    data,
    select: {
      id: true,
      username: true,
      role: true,
      active: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json(user);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Cannot delete yourself
  if (session.user.id === id) {
    return NextResponse.json(
      { error: "Cannot delete your own account" },
      { status: 400 }
    );
  }

  // Cannot delete the last active admin (inactive admins can't sign in, so
  // counting them would allow deleting the only usable admin account)
  const target = await prisma.user.findUnique({ where: { id: id } });
  if (target?.role === "admin" && target.active) {
    const adminCount = await prisma.user.count({
      where: { role: "admin", active: true },
    });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last admin user" },
        { status: 400 }
      );
    }
  }

  await prisma.user.delete({ where: { id: id } });
  return NextResponse.json({ ok: true });
}
