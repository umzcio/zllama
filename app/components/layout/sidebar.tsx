"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession, signOut } from "next-auth/react";
import { useEffect, useState, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  LayoutDashboard,
  Search,
  Package,
  Server,
  HardDrive,
  GitCompare,
  ShieldCheck,
  ClipboardList,
  BarChart3,
  Zap,
  Users,
  Wrench,
  Key,
  Settings,
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Tooltip } from "@/components/ui/tooltip";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

interface NavGroupDef extends NavGroup {
  adminOnly?: boolean;
}

const navGroupsDef: NavGroupDef[] = [
  {
    title: "main",
    items: [
      { href: "/", label: "dashboard", icon: LayoutDashboard },
      { href: "/tools", label: "tools", icon: Wrench },
      { href: "/discover", label: "discover", icon: Search },
      { href: "/gpu", label: "gpu", icon: Zap },
    ],
  },
  {
    title: "admin",
    adminOnly: true,
    items: [
      { href: "/admin/models", label: "models", icon: Package },
      { href: "/admin/servers", label: "servers", icon: Server },
      { href: "/admin/hosts", label: "hosts", icon: HardDrive },
      { href: "/admin/roles", label: "roles", icon: ShieldCheck },
      { href: "/admin/drift", label: "drift", icon: GitCompare },
      { href: "/admin/logs", label: "logs", icon: ClipboardList },
      { href: "/admin/metrics", label: "metrics", icon: BarChart3 },
      { href: "/admin/users", label: "users", icon: Users },
      { href: "/admin/api-keys", label: "apiKeys", icon: Key },
      { href: "/admin/settings", label: "adminSettings", icon: SlidersHorizontal },
    ],
  },
  {
    title: "system",
    items: [
      { href: "/settings", label: "settings", icon: Settings },
    ],
  },
];

const COLLAPSED_KEY = "sidebar-collapsed";

const HIDDEN_ROUTES = ["/setup", "/auth/signin"];

export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const { data: session } = useSession();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    }
    return false;
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      localStorage.setItem(COLLAPSED_KEY, String(!prev));
      return !prev;
    });
  }, []);

  useEffect(() => {
    queueMicrotask(() => setMobileOpen(false));
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [mobileOpen]);

  const handleDrawerKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const focusable = drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !drawer.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const isAdmin = session?.user?.role === "admin";
  const navGroups = navGroupsDef.filter((g) => !g.adminOnly || isAdmin);

  if (HIDDEN_ROUTES.some((route) => pathname.startsWith(route))) {
    return null;
  }

  const renderNavLink = (item: NavItem) => {
    const { href, label, icon: Icon } = item;
    const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);

    const link = (
      <Link
        href={href}
        aria-label={collapsed ? t(label) : undefined}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
          collapsed && "justify-center px-2",
          isActive
            ? "bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] font-medium"
            : "hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]"
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {!collapsed && <span>{t(label)}</span>}
      </Link>
    );

    if (collapsed) {
      return (
        <Tooltip key={href} content={t(label)} side="right">
          {link}
        </Tooltip>
      );
    }

    return <div key={href}>{link}</div>;
  };

  const sidebarContent = (
    <>
      <div className={cn("flex h-14 items-center gap-2.5 border-b px-4 font-semibold", collapsed && "justify-center px-2")}>
        <Image
          src="/logo-32.png"
          alt="zllama"
          width={24}
          height={24}
          className="shrink-0 rounded"
        />
        {!collapsed && <span>zllama</span>}
      </div>

      <div className="flex items-center justify-end border-b px-2 py-1">
        <button
          onClick={toggleCollapsed}
          className="rounded-md p-1.5 transition-colors hover:bg-[hsl(var(--accent))]"
          aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      <nav className="flex-1 overflow-auto p-2">
        {navGroups.map((group, i) => (
          <div key={group.title}>
            {i > 0 && (
              <div className="my-2 flex items-center gap-2 px-3">
                <div className="h-px flex-1 bg-[hsl(var(--border))]" />
                {!collapsed && (
                  <span className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                    {group.title}
                  </span>
                )}
                <div className="h-px flex-1 bg-[hsl(var(--border))]" />
              </div>
            )}
            <div className="space-y-1">
              {group.items.map(renderNavLink)}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t p-3">
        {collapsed ? null : <ThemeToggle />}
      </div>

      {session?.user && (
        <div className={cn("border-t p-3", collapsed && "px-2")}>
          {collapsed ? (
            <Tooltip content={t("logout")} side="right">
              <button
                onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                className="flex w-full items-center justify-center rounded-md p-2 text-sm transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]"
                aria-label={t("logout")}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </Tooltip>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--primary)/0.15)] text-xs font-semibold text-[hsl(var(--primary))]">
                {session.user.name?.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{session.user.name}</p>
                <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">
                  {session.user.role === "admin" ? "Admin" : "User"}
                </p>
              </div>
              <Tooltip content={t("logout")}>
                <button
                  onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                  className="shrink-0 rounded-md p-1.5 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
                  aria-label={t("logout")}
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden h-full flex-col border-r bg-[hsl(var(--sidebar))] text-[hsl(var(--sidebar-foreground))] transition-all duration-200 md:flex",
          collapsed ? "w-16" : "w-56"
        )}
      >
        {sidebarContent}
      </aside>

      {/* Mobile hamburger button */}
      <button
        ref={triggerRef}
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-40 rounded-md border bg-[hsl(var(--card))] p-2 shadow-md md:hidden"
        aria-label={t("openNavigation")}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        >
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("navigation")}
            className="flex h-full w-64 flex-col bg-[hsl(var(--sidebar))] text-[hsl(var(--sidebar-foreground))] shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleDrawerKeyDown}
          >
            <div className="flex h-14 items-center justify-between border-b px-4">
              <div className="flex items-center gap-2.5">
                <Image src="/logo-32.png" alt="zllama" width={24} height={24} className="rounded" />
                <span className="font-semibold">zllama</span>
              </div>
              <button
                ref={closeButtonRef}
                onClick={() => setMobileOpen(false)}
                className="rounded-md p-1 hover:bg-[hsl(var(--accent))]"
                aria-label={t("closeNavigation")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-auto p-2">
              {navGroups.map((group, i) => (
                <div key={group.title}>
                  {i > 0 && (
                    <div className="my-2 flex items-center gap-2 px-3">
                      <div className="h-px flex-1 bg-[hsl(var(--border))]" />
                      <span className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                        {group.title}
                      </span>
                      <div className="h-px flex-1 bg-[hsl(var(--border))]" />
                    </div>
                  )}
                  <div className="space-y-1">
                    {group.items.map(({ href, label, icon: Icon }) => {
                      const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
                      return (
                        <Link
                          key={href}
                          href={href}
                          className={cn(
                            "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                            isActive
                              ? "bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] font-medium"
                              : "hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]"
                          )}
                        >
                          <Icon className="h-4 w-4" />
                          <span>{t(label)}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
            <div className="border-t p-3">
              <ThemeToggle />
            </div>
            {session?.user && (
              <div className="border-t p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--primary)/0.15)] text-xs font-semibold text-[hsl(var(--primary))]">
                    {session.user.name?.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{session.user.name}</p>
                    <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">
                      {session.user.role === "admin" ? "Admin" : "User"}
                    </p>
                  </div>
                  <Tooltip content={t("logout")}>
                    <button
                      onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                      className="shrink-0 rounded-md p-1.5 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
                      aria-label={t("logout")}
                    >
                      <LogOut className="h-4 w-4" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
