"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { withBasePath } from "@/lib/base-path";

export default function RegisterPage() {
  const router = useRouter();
  const t = useTranslations("auth");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/register")
      .then((r) => r.json())
      .then((data) => setEnabled(Boolean(data.enabled)))
      .catch(() => setEnabled(false));
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setConfirmError("");
    if (password !== confirmPassword) {
      setConfirmError(t("passwordMismatch"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        router.push("/auth/signin?registered=1");
        return;
      }
      if (res.status === 403) {
        setEnabled(false);
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || t("registerError"));
    } catch {
      setError(t("registerError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[hsl(var(--background))] bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08)_0%,transparent_60%)]">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-md">
          <Image src="/logo.jpeg" alt="zllama" width={56} height={56} priority />
        </div>
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight">{t("registerTitle")}</h1>
          <p className="mt-0.5 text-sm text-[hsl(var(--muted-foreground))]">{t("registerSubtitle")}</p>
        </div>
      </div>

      <Card className="w-full max-w-sm shadow-lg">
        <CardContent className="pt-6">
          {enabled === false ? (
            <div className="space-y-4">
              <p role="alert" className="text-sm text-[hsl(var(--muted-foreground))]">
                {t("registrationDisabled")}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                size="lg"
                onClick={() => router.push("/auth/signin")}
              >
                {t("backToSignIn")}
              </Button>
            </div>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4" aria-label={t("registerTitle")}>
              <Input
                label={t("username")}
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
              <div className="relative">
                <Input
                  label={t("password")}
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                  className="absolute bottom-0 right-0 flex h-9 w-9 items-center justify-center text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--foreground))]"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Input
                label={t("confirmPassword")}
                name="confirmPassword"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
                error={confirmError || undefined}
              />
              {error && (
                <p role="alert" className="text-sm text-[hsl(var(--destructive))]">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" loading={loading} size="lg">
                {t("createAccount")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
