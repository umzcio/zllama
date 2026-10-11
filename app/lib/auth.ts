import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;

        // `authorize` has no access to the raw request, so the throttle is
        // keyed on the username being attacked rather than a client-supplied
        // header. Fixed policy independent of the admin-tunable proxy rate
        // limit, matching the register route's pattern.
        const rateKey = `signin:${credentials.username}`;
        const rate = checkRateLimit(rateKey, { maxRequests: 10, windowMs: 60_000 });
        if (!rate.allowed) return null;

        const user = await prisma.user.findUnique({
          where: { username: credentials.username },
        });

        if (!user || !user.active) return null;

        const valid = await verifyPassword(credentials.password, user.password);
        if (!valid) return null;

        // Only consume a token on failure — a successful sign-in must not
        // count against the bucket, or an active user's own logins would
        // eventually lock them out.
        resetRateLimit(rateKey);

        return {
          id: user.id,
          name: user.username,
          email: `${user.username}@local`,
          role: user.role,
        };
      },
    }),
  ],
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: {
    signIn: "/auth/signin",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role || "user";
        token.checkedAt = Date.now();
        token.revoked = false;
        return token;
      }

      if (token.id && (!token.checkedAt || Date.now() - token.checkedAt > 60_000)) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id },
          select: { active: true, role: true },
        });
        if (!dbUser || !dbUser.active) {
          delete token.role;
          token.revoked = true;
        } else {
          token.role = dbUser.role;
          token.revoked = false;
        }
        token.checkedAt = Date.now();
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role;
      }
      return session;
    },
  },
};
