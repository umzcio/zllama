import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

export async function POST(req: NextRequest) {
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return NextResponse.json(
      { error: "Admin user already exists" },
      { status: 409 }
    );
  }

  const { username, password } = await req.json();

  if (!username || username.length < 3) {
    return NextResponse.json(
      { error: "Username must be at least 3 characters" },
      { status: 400 }
    );
  }

  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const hashed = await hashPassword(password);

  // The count-then-create must happen atomically: without a transaction, two
  // concurrent first-boot requests could both pass the count check and each
  // create an admin user.
  const user = await prisma.$transaction(async (tx) => {
    const countInTransaction = await tx.user.count();
    if (countInTransaction > 0) {
      return null;
    }
    return tx.user.create({
      data: {
        username,
        password: hashed,
        role: "admin",
      },
    });
  });

  if (!user) {
    return NextResponse.json(
      { error: "Admin user already exists" },
      { status: 409 }
    );
  }

  return NextResponse.json(
    { id: user.id, username: user.username },
    { status: 201 }
  );
}
