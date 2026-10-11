"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useCallback } from "react";
import type { OllamaRunningModel, OllamaShowResponse } from "@/lib/ollama";
import { Package, Search, Cpu, Eye, Trash2, AlertTriangle, Upload, Copy, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CapabilityIcons } from "@/components/ui/capability-icons";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useServers } from "@/lib/hooks/use-servers";
import { useUnloadModel } from "@/lib/hooks/use-unload-model";

interface AdminModel {
  name: string;
  model: string;
  modified_at: string | null;
  size: number | null;
  digest: string | null;
  contextLength?: number | null;
  servedPath?: string | null;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  } | null;
}

interface HostModelInventoryItem {
  hostNodeName: string;
  name: string;
  sizeBytes: number | null;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function ModelsPage() {
  const t = useTranslations("admin.models");
  const tc = useTranslations("common");
  const { toast } = useToast();
  const { servers, selectedServer, setSelectedServer } = useServers();
  const unloadModel = useUnloadModel(tc);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [hostModels, setHostModels] = useState<HostModelInventoryItem[]>([]);
  const [running, setRunning] = useState<OllamaRunningModel[]>([]);
  const [capMap, setCapMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [search, setSearch] = useState("");
  const [inspecting, setInspecting] = useState<OllamaShowResponse | null>(null);
  const [inspectName, setInspectName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [copySource, setCopySource] = useState<string | null>(null);
  const [copyDestination, setCopyDestination] = useState("");
  const [copySubmitting, setCopySubmitting] = useState(false);

  const fetchModels = useCallback(async () => {
    if (!selectedServer) return;
    setLoading(true);
    setConnectionError(false);
    try {
      const [modelsRes, runningRes] = await Promise.all([
        fetch(`/api/admin/models?serverId=${selectedServer}`),
        fetch(`/api/admin/models/running?serverId=${selectedServer}`),
      ]);
      if (!modelsRes.ok) {
        setConnectionError(true);
        setModels([]);
        setHostModels([]);
        setRunning([]);
        return;
      }
      const modelsData = await modelsRes.json();
      const runningData = runningRes.ok ? await runningRes.json() : { models: [] };
      setModels(modelsData.models || []);
      setHostModels(modelsData.hostModels || []);
      setRunning(runningData.models || []);
      fetch("/api/catalog")
        .then((r) => (r.ok ? r.json() : []))
        .then((catalog: { id: string; capabilities: string[] }[]) => {
          const map: Record<string, string[]> = {};
          for (const m of catalog) map[m.id] = m.capabilities;
          setCapMap(map);
        })
        .catch(() => {});
    } catch {
      setConnectionError(true);
      setModels([]);
      setHostModels([]);
      setRunning([]);
    } finally {
      setLoading(false);
    }
  }, [selectedServer]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchModels();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchModels]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch("/api/admin/models/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name: deleteTarget }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast(data.error || t("deleteError"), "error");
      } else {
        toast(t("deleteSuccess", { model: deleteTarget }), "success");
        fetchModels();
      }
    } catch {
      toast(t("deleteError"), "error");
    }
    setDeleteTarget(null);
  };

  const handleInspect = async (name: string) => {
    try {
      const res = await fetch("/api/admin/models/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || t("inspectError"), "error");
        return;
      }
      setInspecting(data);
      setInspectName(name);
    } catch {
      toast(t("inspectError"), "error");
    }
  };

  const handleCopy = async () => {
    if (!copySource || !copyDestination.trim()) return;
    setCopySubmitting(true);
    try {
      const res = await fetch("/api/admin/models/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: selectedServer,
          source: copySource,
          destination: copyDestination.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || t("copyError"), "error");
        return;
      }
      toast(t("copySuccess", { model: copySource, destination: copyDestination.trim() }), "success");
      setCopySource(null);
      setCopyDestination("");
      fetchModels();
    } catch {
      toast(t("copyError"), "error");
    } finally {
      setCopySubmitting(false);
    }
  };

  const handleUnload = async (name: string) => {
    await unloadModel(name, selectedServer);
    fetchModels();
  };

  const isRunning = (name: string) =>
    running.some((r) => r.name === name || r.model === name);

  const getVram = (name: string) => {
    const r = running.find((r) => r.name === name || r.model === name);
    return r ? formatBytes(r.size_vram) : null;
  };

  const filtered = models.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading && models.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} variant="card" />
          ))}
        </div>
      </div>
    );
  }

  if (connectionError && !loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="mt-4 w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <EmptyState
          icon={AlertTriangle}
          title={tc("connectionError")}
          description={tc("connectionErrorDescription")}
          action={<Button onClick={fetchModels}>{tc("retry")}</Button>}
        />
      </div>
    );
  }

  if (models.length === 0 && hostModels.length === 0 && !loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="mt-4 w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <EmptyState
          icon={Package}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={<a href="/discover"><Button>{t("emptyAction")}</Button></a>}
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
      </div>

      <div className="mt-4">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} />
      </div>

      {filtered.length === 0 ? (
        models.length === 0 ? (
          <EmptyState
            icon={Package}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
            action={<a href="/discover"><Button>{t("emptyAction")}</Button></a>}
          />
        ) : (
          <EmptyState icon={Search} title={t("noResults")} description={t("noResultsDescription")} />
        )
      ) : (
        <div className="mt-6">
          <h2 className="sr-only">{t("title")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((model) => (
              <Card key={model.name}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-medium" title={model.name}>{model.name}</h3>
                      {isRunning(model.name) && (
                        <Badge variant="success" className="shrink-0">
                          <Cpu className="mr-1 h-3 w-3" />
                          {t("loaded")} {getVram(model.name) && `· ${getVram(model.name)}`}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                      {formatBytes(model.size)}
                      {capMap[model.name.split(":")[0]] && (
                        <span className="ml-2 inline-flex align-middle">
                          <CapabilityIcons capabilities={capMap[model.name.split(":")[0]]} />
                        </span>
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {model.details?.family && <Badge variant="muted" className="text-[10px]">{model.details.family}</Badge>}
                      {model.details?.parameter_size && <Badge variant="muted" className="text-[10px]">{model.details.parameter_size}</Badge>}
                      {model.details?.quantization_level && <Badge variant="muted" className="text-[10px]">{model.details.quantization_level}</Badge>}
                    </div>
                    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                      <span>
                        {t("digestLabel")}: {model.digest ? model.digest.slice(0, 12) : "—"}
                      </span>
                      <span>
                        {t("contextLengthLabel")}: {model.contextLength != null ? model.contextLength.toLocaleString() : "—"}
                      </span>
                    </p>
                    {model.servedPath && (
                      <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                        {t("servedPathLabel")}: {model.servedPath}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
                      {t("modified")}: {model.modified_at ? new Date(model.modified_at).toLocaleDateString() : "—"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {isRunning(model.name) && (
                      <Button variant="secondary" size="sm" onClick={() => handleUnload(model.name)} title={t("unload")} aria-label={t("unload")}>
                        <Upload className="h-4 w-4" />
                        {t("unload")}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setCopySource(model.name);
                        setCopyDestination("");
                      }}
                      title={t("copy")}
                      aria-label={t("copy")}
                    >
                      <Copy className="h-4 w-4" />
                      {t("copy")}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => handleInspect(model.name)} title={t("inspect")} aria-label={t("inspect")}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(model.name)} title={tc("delete")} aria-label={tc("delete")}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {hostModels.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
            <h2 className="text-lg font-semibold">{t("onDiskTitle")}</h2>
          </div>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            {t("onDiskDescription")}
          </p>
          <div className="mt-3 overflow-x-auto rounded-md border border-[hsl(var(--border))]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--border))] text-left text-xs text-[hsl(var(--muted-foreground))]">
                  <th className="px-3 py-2 font-medium">{t("onDiskHost")}</th>
                  <th className="px-3 py-2 font-medium">{t("name")}</th>
                  <th className="px-3 py-2 font-medium">{t("size")}</th>
                </tr>
              </thead>
              <tbody>
                {hostModels.map((hm, i) => (
                  <tr key={`${hm.hostNodeName}:${hm.name}:${i}`} className="border-b border-[hsl(var(--border))] last:border-0">
                    <td className="px-3 py-2">{hm.hostNodeName}</td>
                    <td className="px-3 py-2 font-mono text-xs">{hm.name}</td>
                    <td className="px-3 py-2">{formatBytes(hm.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={!!inspecting} onClose={() => setInspecting(null)} title={inspectName}>
        {inspecting && (
          <div className="space-y-3 text-sm">
            <div><span className="font-medium">Family:</span> {inspecting.details?.family || "—"}</div>
            <div><span className="font-medium">Parameters:</span> {inspecting.details?.parameter_size || "—"}</div>
            <div><span className="font-medium">Quantization:</span> {inspecting.details?.quantization_level || "—"}</div>
            <div><span className="font-medium">Format:</span> {inspecting.details?.format || "—"}</div>
            {inspecting.parameters && (
              <div>
                <span className="font-medium">Parameters:</span>
                <pre className="mt-1 overflow-auto rounded-md bg-[hsl(var(--muted))] p-3 text-xs">{inspecting.parameters}</pre>
              </div>
            )}
            {inspecting.template && (
              <div>
                <span className="font-medium">Template:</span>
                <pre className="mt-1 overflow-auto rounded-md bg-[hsl(var(--muted))] p-3 text-xs">{inspecting.template}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!copySource}
        onClose={() => {
          setCopySource(null);
          setCopyDestination("");
        }}
        title={t("copy")}
      >
        {copySource && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              handleCopy();
            }}
          >
            <p className="text-sm text-[hsl(var(--muted-foreground))]">{copySource}</p>
            <Input
              label={t("copyDestination")}
              value={copyDestination}
              onChange={(e) => setCopyDestination(e.target.value)}
              autoFocus
              required
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCopySource(null);
                  setCopyDestination("");
                }}
              >
                {tc("cancel")}
              </Button>
              <Button type="submit" loading={copySubmitting} disabled={!copyDestination.trim()}>
                {tc("confirm")}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title={t("deleteTitle")}
        description={t("deleteDescription", { model: deleteTarget || "" })}
        confirmLabel={tc("delete")}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
