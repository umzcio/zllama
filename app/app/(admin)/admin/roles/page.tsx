"use client";

import { useTranslations, useFormatter } from "next-intl";
import { useEffect, useState, useCallback } from "react";
import { ShieldCheck, Plus, Pencil, Trash2, X, ArrowUpCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { parseDeclaration } from "@/lib/desired-state";
// The route's own type, not a hand-written copy — see the drift page for
// why that matters.
import type { UpstreamRelease } from "@/lib/upstream";

interface Role {
  id: string;
  name: string;
  description: string | null;
  desiredState: string;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_DECLARATION = "{\n  \"runtimes\": {}\n}";

function pinnedOllamaVersion(desiredState: string): string | undefined {
  try {
    return parseDeclaration(desiredState).runtimes.ollama?.version;
  } catch {
    return undefined;
  }
}

export default function RolesPage() {
  const t = useTranslations("admin.roles");
  const tc = useTranslations("common");
  const format = useFormatter();
  const { toast } = useToast();

  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    desiredState: EMPTY_DECLARATION,
  });
  const [upstream, setUpstream] = useState<UpstreamRelease | null>(null);
  const [checkingUpstream, setCheckingUpstream] = useState(false);
  const [bumpingId, setBumpingId] = useState<string | null>(null);

  const fetchRoles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/roles");
      if (!res.ok) throw new Error("Failed to fetch roles");
      const data = await res.json();
      setRoles(data);
      setError(false);
    } catch {
      setRoles([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetched independently of the roles list: an unreachable or slow
  // upstream check must never block or fail the roles page itself.
  const fetchUpstream = useCallback(async () => {
    try {
      const res = await fetch("/api/upstream");
      if (!res.ok) return;
      const data = await res.json();
      setUpstream(data.ollama ?? null);
    } catch {
      setUpstream(null);
    }
  }, []);

  useEffect(() => {
    fetchRoles();
    fetchUpstream();
  }, [fetchRoles, fetchUpstream]);

  const handleCheckNow = async () => {
    setCheckingUpstream(true);
    try {
      const res = await fetch("/api/upstream/refresh", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setUpstream(data.ollama ?? null);
      }
    } catch {
      // A failed check-now leaves the last known upstream state in place.
    } finally {
      setCheckingUpstream(false);
    }
  };

  const handleBump = async (role: Role) => {
    if (!upstream?.latest) return;
    setBumpingId(role.id);
    try {
      const declaration = parseDeclaration(role.desiredState);
      const ollama = declaration.runtimes.ollama;
      if (!ollama) return;

      const updated = {
        ...declaration,
        runtimes: { ...declaration.runtimes, ollama: { ...ollama, version: upstream.latest } },
      };

      const res = await fetch(`/api/roles/${role.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desiredState: JSON.stringify(updated) }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast(data?.error || tc("error"), "error");
      } else {
        toast(t("roleUpdated"), "success");
        fetchRoles();
      }
    } catch {
      toast(tc("error"), "error");
    } finally {
      setBumpingId(null);
    }
  };

  const resetForm = () => {
    setForm({ name: "", description: "", desiredState: EMPTY_DECLARATION });
    setEditingId(null);
    setShowForm(false);
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    const method = editingId ? "PUT" : "POST";
    const url = editingId ? `/api/roles/${editingId}` : "/api/roles";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setFormError(data?.error || tc("error"));
        return;
      }

      toast(
        editingId ? t("roleUpdated") : t("roleCreated", { name: form.name }),
        "success"
      );
      resetForm();
      fetchRoles();
    } catch {
      setFormError(tc("error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (role: Role) => {
    setForm({
      name: role.name,
      description: role.description || "",
      desiredState: role.desiredState,
    });
    setEditingId(role.id);
    setFormError(null);
    setShowForm(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/roles/${deleteTarget}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast(data?.error || tc("error"), "error");
      } else {
        toast(t("roleDeleted"), "success");
        fetchRoles();
      }
    } catch {
      toast(tc("error"), "error");
    }
    setDeleteTarget(null);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-6">
          <Skeleton variant="line" className="mb-2 h-8 w-32" />
          <Skeleton variant="line" className="h-4 w-64" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} variant="row" className="h-20" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title={t("errorTitle")}
        description={t("errorDescription")}
        action={<Button onClick={fetchRoles}>{tc("retry")}</Button>}
      />
    );
  }

  if (roles.length === 0 && !showForm) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title={t("emptyTitle")}
        description={t("emptyDescription")}
        action={
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("addRole")}
          </Button>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{t("subtitle")}</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
            {upstream ? (
              <span>
                {t("checkedAgo", { time: format.relativeTime(new Date(upstream.checkedAt)) })}
                {upstream.stale ? ` ${t("upstreamStaleHint")}` : ""}
              </span>
            ) : (
              <span>{t("upstreamUnknown")}</span>
            )}
            <Button variant="ghost" size="sm" onClick={handleCheckNow} loading={checkingUpstream}>
              <RefreshCw className="mr-1 h-3 w-3" />
              {t("checkNow")}
            </Button>
          </div>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("addRole")}
          </Button>
        )}
      </div>

      {showForm && (
        <Card className="mb-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{editingId ? t("editRole") : t("addRole")}</h2>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md p-1.5 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
              aria-label={tc("cancel")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label={t("roleName")}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              placeholder="gpu-worker"
            />
            <Input
              label={t("description")}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder=""
            />
            <div>
              <Textarea
                label={t("declaration")}
                value={form.desiredState}
                onChange={(e) => setForm({ ...form, desiredState: e.target.value })}
                required
                rows={10}
                spellCheck={false}
                className="font-mono text-xs"
                error={formError || undefined}
              />
              <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                {t("declarationHelp")}
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-[hsl(var(--border))] pt-4">
              <Button type="button" variant="secondary" onClick={resetForm}>
                {tc("cancel")}
              </Button>
              <Button type="submit" loading={submitting}>
                {editingId ? tc("save") : tc("create")}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="space-y-3">
        {roles.map((role) => (
          <Card key={role.id} className="group">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{role.name}</div>
                {role.description && (
                  <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                    {role.description}
                  </p>
                )}
                <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-[hsl(var(--muted))] p-2 text-xs">
                  {role.desiredState}
                </pre>
                {(() => {
                  const pin = pinnedOllamaVersion(role.desiredState);
                  if (!pin) return null;

                  if (!upstream?.latest) {
                    return (
                      <div className="mt-2 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
                        <span>{t("upstreamUnknown")}</span>
                        <Button variant="ghost" size="sm" onClick={handleCheckNow} loading={checkingUpstream}>
                          {t("checkNow")}
                        </Button>
                      </div>
                    );
                  }

                  if (pin === upstream.latest) {
                    return (
                      <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
                        {t("upstreamCurrent", { version: upstream.latest })}
                      </p>
                    );
                  }

                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="warning">
                        <ArrowUpCircle className="mr-1 h-3 w-3" />
                        {t("upstreamUpdateAvailable")}
                      </Badge>
                      <span className="text-[hsl(var(--muted-foreground))]">
                        {t("upstreamPinLabel", { pin })} · {t("upstreamLatestLabel", { latest: upstream.latest })}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleBump(role)}
                        loading={bumpingId === role.id}
                      >
                        {t("upstreamBumpTo", { latest: upstream.latest })}
                      </Button>
                    </div>
                  );
                })()}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleEdit(role)}
                  title={tc("edit")}
                  aria-label={tc("edit")}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(role.id)}
                  className="text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive))]"
                  title={tc("delete")}
                  aria-label={tc("delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title={t("deleteRoleTitle")}
        description={t("deleteConfirm")}
        confirmLabel={tc("delete")}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
