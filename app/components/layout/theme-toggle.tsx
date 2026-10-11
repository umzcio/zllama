"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore, useRef, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Sun, Moon, Monitor } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const emptySubscribe = () => () => {};
const returnTrue = () => true;
const returnFalse = () => false;

const modes: { key: string; labelKey: string; icon: LucideIcon }[] = [
  { key: "light", labelKey: "themeLight", icon: Sun },
  { key: "dark", labelKey: "themeDark", icon: Moon },
  { key: "system", labelKey: "themeAuto", icon: Monitor },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations("settings");
  const mounted = useSyncExternalStore(emptySubscribe, returnTrue, returnFalse);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (!mounted) return null;

  const selectedIndex = Math.max(
    0,
    modes.findIndex((m) => m.key === theme)
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % modes.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + modes.length) % modes.length;
        break;
      default:
        return;
    }
    e.preventDefault();
    setTheme(modes[next].key);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div className="flex gap-1" role="radiogroup" aria-label={t("theme")}>
      {modes.map(({ key, labelKey, icon: Icon }, index) => {
        const checked = theme === key;
        return (
          <button
            key={key}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            role="radio"
            aria-checked={checked}
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => setTheme(key)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
              checked
                ? "bg-[hsl(var(--accent))] font-medium"
                : "hover:bg-[hsl(var(--accent))]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}
