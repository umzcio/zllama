"use client";

import { useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor, Globe, Palette, KeyRound, type LucideIcon } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useDensity } from "@/components/providers/density-provider";

interface RadioOption {
  value: string;
  label: string;
  icon?: LucideIcon;
}

function RadioGroupField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = options.findIndex((o) => o.value === value);
  const rovingIndex = checkedIndex === -1 ? 0 : checkedIndex;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = options.length;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % count;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + count) % count;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-medium">{label}</label>
      <div className="flex gap-2" role="radiogroup" aria-label={label}>
        {options.map((opt, index) => {
          const Icon = opt.icon;
          const checked = value === opt.value;
          return (
            <button
              key={opt.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              role="radio"
              aria-checked={checked}
              tabIndex={index === rovingIndex ? 0 : -1}
              onClick={() => onChange(opt.value)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors ${
                checked
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "hover:bg-[hsl(var(--accent))]"
              }`}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  const changePassword = async () => {
    setPwError("");
    if (newPassword.length < 8) {
      setPwError(t("passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError(t("passwordMismatch"));
      return;
    }
    setChangingPassword(true);
    try {
      const res = await fetch("/api/users/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error === "wrongCurrentPassword") {
          setPwError(t("wrongCurrentPassword"));
        } else if (data.error === "weakPassword") {
          setPwError(t("passwordTooShort"));
        } else {
          toast(t("passwordChangeError"), "error");
        }
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast(t("passwordChanged"), "success");
    } catch {
      toast(t("passwordChangeError"), "error");
    } finally {
      setChangingPassword(false);
    }
  };

  if (!mounted) return null;

  const currentLocale =
    typeof document !== "undefined" ? document.cookie.match(/locale=(\w+)/)?.[1] || "en" : "en";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            {t("appearance")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroupField
            label={t("theme")}
            value={theme ?? "system"}
            onChange={setTheme}
            options={[
              { value: "light", label: t("themeLight"), icon: Sun },
              { value: "dark", label: t("themeDark"), icon: Moon },
              { value: "system", label: t("themeAuto"), icon: Monitor },
            ]}
          />

          <RadioGroupField
            label={t("density")}
            value={density}
            onChange={(v) => setDensity(v as "compact" | "normal" | "spacious")}
            options={[
              { value: "compact", label: t("compact") },
              { value: "normal", label: t("normal") },
              { value: "spacious", label: t("spacious") },
            ]}
          />

          <div>
            <label className="mb-2 block text-sm font-medium">
              <Globe className="mr-1 inline h-4 w-4" />
              {t("language")}
            </label>
            <Select
              value={currentLocale}
              onChange={async (e) => {
                await fetch("/api/locale", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ locale: e.target.value }),
                });
                window.location.reload();
              }}
              className="w-auto"
              aria-label={t("language")}
            >
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="ca">Català</option>
              <option value="fr">Français</option>
              <option value="ja">日本語</option>
              <option value="zh">中文</option>
              <option value="hi">हिन्दी</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            {t("changePassword")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            label={t("currentPassword")}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <Input
            label={t("newPassword")}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <Input
            label={t("confirmPassword")}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={pwError || undefined}
          />
          <Button
            onClick={changePassword}
            loading={changingPassword}
            disabled={!currentPassword || !newPassword || !confirmPassword}
          >
            {t("updatePassword")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
