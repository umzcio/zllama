"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Database, Gauge, Shield, UserPlus } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

type DbStatus = "loading" | "ok" | "error";

export default function AdminSettingsPage() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const { toast } = useToast();

  const [allowRegistration, setAllowRegistration] = useState(false);
  const [logRetentionDays, setLogRetentionDays] = useState("90");
  const [rateLimitMax, setRateLimitMax] = useState("60");
  const [rateLimitWindow, setRateLimitWindow] = useState("60");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const [dbStatus, setDbStatus] = useState<DbStatus>("loading");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error();
      const settings = await res.json();
      setAllowRegistration(settings.allowRegistration === "true");
      if (settings.logRetentionDays) setLogRetentionDays(settings.logRetentionDays);
      if (settings.rateLimitMax) setRateLimitMax(settings.rateLimitMax);
      if (settings.rateLimitWindow) setRateLimitWindow(settings.rateLimitWindow);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHealth = useCallback(async () => {
    setDbStatus("loading");
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setDbStatus(data?.checks?.database === "ok" ? "ok" : "error");
    } catch {
      setDbStatus("error");
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadHealth();
  }, [loadSettings, loadHealth]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowRegistration: allowRegistration ? "true" : "false",
          logRetentionDays,
          rateLimitMax,
          rateLimitWindow,
        }),
      });
      if (!res.ok) throw new Error();
      toast(t("saved"), "success");
    } catch {
      toast(t("saveError"), "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-bold">{t("systemTitle")}</h1>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <h1 className="text-2xl font-bold">{t("systemTitle")}</h1>
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{t("loadError")}</p>
            <Button variant="secondary" onClick={() => void loadSettings()}>
              {tc("retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">{t("systemTitle")}</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-5 w-5" />
                {t("registration")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Switch
                label={t("allowRegistration")}
                checked={allowRegistration}
                onChange={(e) => setAllowRegistration(e.target.checked)}
              />
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                {t("allowRegistrationDescription")}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                {t("loggingPrivacy")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label={t("logRetentionDays")}
                type="number"
                min={1}
                value={logRetentionDays}
                onChange={(e) => setLogRetentionDays(e.target.value)}
              />
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                {t("logRetentionDescription")}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Gauge className="h-5 w-5" />
                {t("rateLimit")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label={t("rateLimitMax")}
                type="number"
                min={1}
                value={rateLimitMax}
                onChange={(e) => setRateLimitMax(e.target.value)}
              />
              <Input
                label={t("rateLimitWindow")}
                type="number"
                min={1}
                value={rateLimitWindow}
                onChange={(e) => setRateLimitWindow(e.target.value)}
              />
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                {t("rateLimitDescription")}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                {t("database")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                {dbStatus === "loading" ? (
                  <Skeleton className="h-6 w-24" />
                ) : (
                  <Badge variant={dbStatus === "ok" ? "success" : "destructive"}>
                    {dbStatus === "ok" ? t("databaseReachable") : t("databaseUnreachable")}
                  </Badge>
                )}
                <span className="text-sm text-[hsl(var(--muted-foreground))]">
                  {t("databaseType")}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex items-center rounded-lg border bg-[hsl(var(--card))] px-4 py-3">
        <Button onClick={saveSettings} loading={saving}>
          {t("saveChanges")}
        </Button>
      </div>
    </div>
  );
}
