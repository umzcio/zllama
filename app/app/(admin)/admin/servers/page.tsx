"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useCallback } from "react";
import {
  Server as ServerIcon,
  Plus,
  Pencil,
  Trash2,
  Wifi,
  X,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { notifyServersChanged } from "@/lib/server-events";

interface HostSummary {
  id: string;
  nodeName: string;
  status: string;
}

interface Server {
  id: string;
  name: string;
  url: string;
  active: boolean;
  createdAt: string;
  hosts?: HostSummary[];
}

interface HostOption {
  id: string;
  nodeName: string;
  approvalState: string;
}

interface HealthStatus {
  id: string;
  status: "online" | "offline";
  version?: string;
}

function StatusDot({ status }: { status?: "online" | "offline" }) {
  const isOnline = status === "online";
  return (
    <span
      role="img"
      aria-label={isOnline ? "Online" : "Offline"}
      className="relative flex h-3 w-3"
    >
      {isOnline && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      )}
      <span
        className={`relative inline-flex h-3 w-3 rounded-full ${
          isOnline ? "bg-emerald-500" : "bg-[hsl(var(--muted-foreground))]"
        }`}
      />
    </span>
  );
}

function StatusLabel({
  status,
  version,
  t,
}: {
  status?: "online" | "offline";
  version?: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const isOnline = status === "online";
  return (
    <span
      className={`text-xs font-medium ${
        isOnline ? "text-[hsl(var(--success))]" : "text-[hsl(var(--muted-foreground))]"
      }`}
    >
      {isOnline ? t("online") : t("offline")}
      {isOnline && version && (
        <span className="ml-1.5 text-[hsl(var(--muted-foreground))]">v{version}</span>
      )}
    </span>
  );
}

export default function ServersPage() {
  const t = useTranslations("admin.servers");
  const tc = useTranslations("common");
  const { toast } = useToast();
  const [servers, setServers] = useState<Server[]>([]);
  const [health, setHealth] = useState<Record<string, HealthStatus>>({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    url: "",
    active: true,
    hostIds: [] as string[],
  });
  const [hosts, setHosts] = useState<HostOption[]>([]);
  const [hostsLoading, setHostsLoading] = useState(true);
  const [hostsError, setHostsError] = useState(false);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/servers?all=true");
      const data = await res.json();
      setServers(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHosts = useCallback(async () => {
    setHostsLoading(true);
    try {
      const res = await fetch("/api/hosts");
      if (!res.ok) throw new Error("Failed to fetch hosts");
      const data = await res.json();
      setHosts(data);
      setHostsError(false);
    } catch {
      setHosts([]);
      setHostsError(true);
    } finally {
      setHostsLoading(false);
    }
  }, []);

  const checkHealth = useCallback(async (server: Server) => {
    try {
      const res = await fetch(`/api/servers/${server.id}/health`);
      const data: HealthStatus = await res.json();
      setHealth((prev) => ({ ...prev, [server.id]: data }));
    } catch {
      setHealth((prev) => ({
        ...prev,
        [server.id]: { id: server.id, status: "offline" },
      }));
    }
  }, []);

  useEffect(() => {
    fetchServers();
    fetchHosts();
  }, [fetchServers, fetchHosts]);

  useEffect(() => {
    servers.forEach((s) => {
      if (s.active) checkHealth(s);
    });
  }, [servers, checkHealth]);

  const resetForm = () => {
    setForm({ name: "", url: "", active: true, hostIds: [] });
    setEditingId(null);
    setShowForm(false);
  };

  const toggleHostSelection = (hostId: string) => {
    setForm((prev) => ({
      ...prev,
      hostIds: prev.hostIds.includes(hostId)
        ? prev.hostIds.filter((id) => id !== hostId)
        : [...prev.hostIds, hostId],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const method = editingId ? "PUT" : "POST";
    const url = editingId ? `/api/servers/${editingId}` : "/api/servers";
    const payload: {
      name: string;
      url: string;
      active: boolean;
      hostIds?: string[];
    } = {
      name: form.name,
      url: form.url,
      active: form.active,
    };
    if (editingId) {
      payload.hostIds = form.hostIds;
    }

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast(data?.error || tc("error"), "error");
        return;
      }

      toast(
        editingId ? t("serverUpdated") : t("serverCreated", { name: form.name }),
        "success"
      );
      notifyServersChanged();
      resetForm();
      fetchServers();
    } catch {
      toast(tc("error"), "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (server: Server) => {
    setForm({
      name: server.name,
      url: server.url,
      active: server.active,
      hostIds: server.hosts?.map((h) => h.id) ?? [],
    });
    setEditingId(server.id);
    setShowForm(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/servers/${deleteTarget}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast(data?.error || tc("error"), "error");
      } else {
        toast(t("serverDeleted"), "success");
        notifyServersChanged();
        fetchServers();
      }
    } catch {
      toast(tc("error"), "error");
    }
    setDeleteTarget(null);
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch(`/api/servers/${id}/test`, { method: "POST" });
      const data = await res.json();
      setHealth((prev) => ({
        ...prev,
        [id]: { id, status: data.status, version: data.version },
      }));
      if (data.status === "online") {
        toast(`Connection successful (v${data.version || "?"})`, "success");
      } else {
        toast("Connection failed", "error");
      }
    } catch {
      toast("Connection failed", "error");
    } finally {
      setTestingId(null);
    }
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

  if (servers.length === 0 && !showForm) {
    return (
      <EmptyState
        icon={ServerIcon}
        title={t("emptyTitle")}
        description={t("emptyDescription")}
        action={
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("emptyAction")}
          </Button>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {t("subtitle")}
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("addServer")}
          </Button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <Card className="mb-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              {editingId ? t("editServer") : t("addServer")}
            </h2>
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
              label={t("serverName")}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              placeholder="My Ollama Endpoint"
            />

            <Input
              label={t("serverUrl")}
              type="url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              required
              placeholder="http://localhost:11434"
            />

            <div className="flex items-center justify-between border-t border-[hsl(var(--border))] pt-4">
              <Switch
                id="active"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                label={t("active")}
              />
            </div>

            {editingId && (
              <div className="border-t border-[hsl(var(--border))] pt-4">
                <h3 className="mb-2 text-sm font-medium">{t("hostsTitle")}</h3>
                {hostsLoading ? (
                  <div className="space-y-2">
                    <Skeleton variant="line" className="h-5 w-40" />
                    <Skeleton variant="line" className="h-5 w-40" />
                  </div>
                ) : hostsError ? (
                  <div className="flex items-center justify-between text-sm text-[hsl(var(--destructive))]">
                    <span>{t("hostsError")}</span>
                    <Button type="button" variant="secondary" size="sm" onClick={fetchHosts}>
                      {tc("retry")}
                    </Button>
                  </div>
                ) : hosts.length === 0 ? (
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    {t("hostsEmpty")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {hosts.map((host) => (
                      <div key={host.id} className="flex items-center gap-2">
                        <Switch
                          id={`host-${host.id}`}
                          checked={form.hostIds.includes(host.id)}
                          onChange={() => toggleHostSelection(host.id)}
                          label={host.nodeName}
                        />
                        {host.approvalState !== "approved" && (
                          <Badge variant="warning">{t("hostPending")}</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

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

      {/* Server list */}
      <div className="space-y-3">
        {servers.map((server) => {
          const h = health[server.id];
          const isTesting = testingId === server.id;
          return (
            <Card key={server.id} className="group transition-colors hover:border-[hsl(var(--primary)/0.3)]">
              <div className="flex items-center justify-between gap-4">
                {/* Left: status + info */}
                <div className="flex min-w-0 items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--muted))]">
                    <ServerIcon className="h-5 w-5 text-[hsl(var(--muted-foreground))]" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{server.name}</span>
                      <StatusDot status={h?.status} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                      <span className="inline-flex items-center gap-1">
                        <Globe className="h-3 w-3" />
                        <span className="truncate">{server.url}</span>
                      </span>
                      <StatusLabel status={h?.status} version={h?.version} t={t} />
                    </div>
                  </div>
                </div>

                {/* Right: actions */}
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleTest(server.id)}
                    loading={isTesting}
                    title={t("testConnection")}
                    aria-label={t("testConnection")}
                  >
                    <Wifi className="h-4 w-4" />
                    <span className="hidden sm:inline">{t("testConnection")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleEdit(server)}
                    title={tc("edit")}
                    aria-label={tc("edit")}
                  >
                    <Pencil className="h-4 w-4" />
                    <span className="hidden sm:inline">{tc("edit")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(server.id)}
                    className="text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive))]"
                    title={tc("delete")}
                    aria-label={tc("delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="hidden sm:inline">{tc("delete")}</span>
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title={t("deleteTitle")}
        description={t("deleteConfirm")}
        confirmLabel={tc("delete")}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
