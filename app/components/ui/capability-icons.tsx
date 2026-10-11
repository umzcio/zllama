"use client";

import { MessageSquare, Wrench, Eye, Layers, Zap, Code } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

const CAP_ICONS: Record<string, React.ReactNode> = {
  text:      <MessageSquare className="h-3.5 w-3.5" />,
  tools:     <Wrench className="h-3.5 w-3.5" />,
  vision:    <Eye    className="h-3.5 w-3.5" />,
  embedding: <Layers className="h-3.5 w-3.5" />,
  thinking:  <Zap    className="h-3.5 w-3.5" />,
  code:      <Code   className="h-3.5 w-3.5" />,
};

const CAP_COLORS: Record<string, string> = {
  text:      "hsl(var(--muted-foreground))",
  tools:     "hsl(38 92% 50%)",
  vision:    "hsl(217 91% 60%)",
  embedding: "hsl(271 81% 56%)",
  thinking:  "hsl(142 71% 45%)",
  code:      "hsl(25 95% 53%)",
};

interface CapabilityIconsProps {
  capabilities: string[];
  className?: string;
}

export function CapabilityIcons({ capabilities, className }: CapabilityIconsProps) {
  const t = useTranslations("discover");
  if (capabilities.length === 0) return null;
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {capabilities.map((cap) => {
        const icon = CAP_ICONS[cap];
        if (!icon) return null;
        const label = t.has(`capabilities.${cap}`) ? t(`capabilities.${cap}`) : cap;
        return (
          <Tooltip key={cap} content={label}>
            <span
              role="img"
              aria-label={label}
              tabIndex={0}
              className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
              style={{ color: CAP_COLORS[cap] ?? "hsl(var(--muted-foreground))" }}
            >
              {icon}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

export { CAP_ICONS, CAP_COLORS, type CapabilityIconsProps };
