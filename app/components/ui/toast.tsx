"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";

type ToastVariant = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const variantStyles: Record<ToastVariant, string> = {
  success: "border-[hsl(var(--success))] bg-[hsl(var(--card))]",
  error: "border-[hsl(var(--destructive))] bg-[hsl(var(--card))]",
  info: "border-[hsl(var(--primary))] bg-[hsl(var(--card))]",
  warning: "border-[hsl(var(--warning))] bg-[hsl(var(--card))]",
};

const variantIcons: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const variantIconColors: Record<ToastVariant, string> = {
  success: "text-[hsl(var(--success))]",
  error: "text-[hsl(var(--destructive))]",
  info: "text-[hsl(var(--primary))]",
  warning: "text-[hsl(var(--warning))]",
};

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = "info", duration?: number) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const dur = duration ?? (variant === "error" ? 8000 : 4000);
      setToasts((prev) => [...prev, { id, message, variant, duration: dur }]);
    },
    []
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
        aria-live="polite"
        role="status"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const t = useTranslations("common");
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration);
  const Icon = variantIcons[toast.variant];

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [paused, toast.id, onDismiss]);

  return (
    <div
      className={cn(
        "flex max-w-sm items-center gap-3 rounded-lg border px-4 py-3 shadow-md animate-in slide-in-from-right",
        variantStyles[toast.variant]
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className={cn("h-4 w-4 shrink-0", variantIconColors[toast.variant])} aria-hidden="true" />
      <span className="text-sm">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="ml-2 shrink-0 rounded p-0.5 hover:bg-[hsl(var(--accent))]"
        aria-label={t("dismiss")}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export { ToastProvider, useToast };
