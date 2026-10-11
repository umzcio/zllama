"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import { basePath, installBasePathFetch } from "@/lib/base-path";

installBasePathFetch();

const authBasePath = basePath ? `${basePath}/api/auth` : undefined;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return <NextAuthSessionProvider basePath={authBasePath}>{children}</NextAuthSessionProvider>;
}
