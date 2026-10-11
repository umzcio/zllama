"use client";

import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { Search, Check, Download, Loader2, AlertTriangle, FolderPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { useServers } from "@/lib/hooks/use-servers";
import { scoreModel, gradeColor, gradeBg, type Grade } from "@/lib/model-scoring";
import { CapabilityIcons } from "@/components/ui/capability-icons";
import {
  parseDeclaration,
  serializeDeclaration,
  type Declaration,
  type ModelDeclaration,
  type RuntimeKind,
} from "@/lib/desired-state";

interface CatalogModel {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

/** The engine-agnostic catalog entry shape from `searchCatalog` — used for
 * the vLLM/HuggingFace tab, which has no size tags, capabilities, or pull
 * counts the way the ollama.com scrape does. */
interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  sizeBytes?: number;
}

interface Role {
  id: string;
  name: string;
  desiredState: string;
}

interface GpuSpecs {
  gpuName: string;
  vramGB: number;
  bandwidthGBs: number | null;
}

const CAPABILITY_OPTIONS = ["text", "tools", "vision", "embedding", "thinking"];
const ENGINE_OPTIONS: RuntimeKind[] = ["ollama", "vllm"];

const GRADE_LABELS: Record<Grade, string> = {
  S: "≥50 t/s", A: "≥30 t/s", B: "≥15 t/s", C: "≥8 t/s", D: "≥3 t/s", F: "no fit",
};


// Estimate model size in GB from a tag like "7b", "13b", "70b" using Q4 approximation.
function parseTagToSizeGB(tag: string): number | null {
  // Normalize: MoE "8x7b" → "7b", e-series "e2b" → "2b"
  const t = tag.toLowerCase().replace(/^\d+x/, "").replace(/^e(\d)/, "$1");
  const bMatch = t.match(/^(\d+(?:\.\d+)?)b$/);
  if (bMatch) return parseFloat(bMatch[1]) * 0.55;
  const mMatch = t.match(/^(\d+(?:\.\d+)?)m$/);
  if (mMatch) return (parseFloat(mMatch[1]) / 1000) * 0.55;
  return null;
}

// ollama.com reports a parameter-count tag ("7b", "70b"), not a byte size.
// This is the same Q4 estimate `parseTagToSizeGB` already uses for GPU-fit
// scoring, reused here as the best available size for a role declaration
// — an approximation, not a size ollama.com reports directly. A tag this
// can't parse (e.g. "latest") yields no estimate, and the declared model
// simply has no sizeBytes — the agent's disk check then blocks it as a
// fail-safe rather than assuming it fits.
function estimateSizeBytesFromTag(tag: string): number | undefined {
  const sizeGB = parseTagToSizeGB(tag);
  return sizeGB === null ? undefined : Math.round(sizeGB * 1_000_000_000);
}

function parseRelativeTime(text: string): number {
  const match = text.toLowerCase().match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return 0;
  const n = parseInt(match[1]);
  const ms: Record<string, number> = { second: 1e3, minute: 6e4, hour: 3.6e6, day: 86.4e6, week: 6.048e8, month: 2.628e9, year: 3.154e10 };
  return Date.now() - n * (ms[match[2]] ?? 0);
}

function vramStyle(memPct: number): React.CSSProperties {
  if (memPct >= 100) return { color: "hsl(var(--muted-foreground))", background: "hsl(var(--muted))" };
  if (memPct >= 80)  return { color: "hsl(var(--grade-f))", background: "hsl(var(--grade-f) / 0.15)" };
  if (memPct >= 60)  return { color: "hsl(var(--grade-c))", background: "hsl(var(--grade-c) / 0.15)" };
  return               { color: "hsl(var(--grade-b))", background: "hsl(var(--grade-b) / 0.15)" };
}

export default function DiscoverPage() {
  const t = useTranslations("discover");
  const tc = useTranslations("common");
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const { toast } = useToast();
  const { servers, selectedServer, setSelectedServer } = useServers();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCaps, setSelectedCaps] = useState<string[]>(["text"]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());
  const [downloadingRefs, setDownloadingRefs] = useState<Set<string>>(new Set());
  const [gpuSpecs, setGpuSpecs] = useState<GpuSpecs | null>(null);
  const [fitsGpuOnly, setFitsGpuOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"updated" | "grade">("updated");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [engine, setEngine] = useState<RuntimeKind>("ollama");
  const [vllmEntries, setVllmEntries] = useState<CatalogEntry[]>([]);
  const [vllmLoading, setVllmLoading] = useState(false);
  const [vllmError, setVllmError] = useState(false);

  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [addingRoleFor, setAddingRoleFor] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedServer) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/models?serverId=${selectedServer}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (data.models && !cancelled) {
          setDownloadedModels(new Set(data.models.map((m: { name: string }) => m.name)));
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [selectedServer]);

  useEffect(() => {
    if (!selectedServer) return;
    fetch(`/api/gpu/specs?serverId=${selectedServer}`)
      .then((r) => r.json())
      .then((data: GpuSpecs | null) => setGpuSpecs(data))
      .catch(() => {});
  }, [selectedServer]);

  // Poll for download status
  useEffect(() => {
    if (downloadingRefs.size === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      if (!selectedServer) return;
      try {
        const [statusRes, modelsRes] = await Promise.all([
          fetch(`/api/admin/models/pull/status?serverId=${selectedServer}`),
          fetch(`/api/admin/models?serverId=${selectedServer}`),
        ]);

        if (statusRes.ok) {
          const jobs: { model: string; tag: string; status: string; error?: string }[] = await statusRes.json();
          for (const job of jobs) {
            const ref = job.tag ? `${job.model}:${job.tag}` : job.model;
            if (job.status === "error") {
              setDownloadingRefs((prev) => {
                if (!prev.has(ref)) return prev;
                const next = new Set(prev); next.delete(ref);
                toast(job.error ? `${t("pullError", { name: ref })}: ${job.error}` : t("pullError", { name: ref }), "error");
                return next;
              });
            }
          }
        }

        if (modelsRes.ok) {
          const data = await modelsRes.json();
          if (data.models) {
            const names = new Set<string>(data.models.map((m: { name: string }) => m.name));
            setDownloadedModels(names);
            setDownloadingRefs((prev) => {
              const next = new Set(prev); let changed = false;
              for (const ref of prev) {
                if (names.has(ref) || [...names].some((n) => n.startsWith(`${ref}-`))) {
                  next.delete(ref); changed = true;
                  toast(t("pullComplete", { name: ref }), "success");
                }
              }
              return changed ? next : prev;
            });
          }
        }
      } catch { /* ignore polling errors */ }
    }, 5000);

    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [downloadingRefs.size, selectedServer, t, toast]);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setCatalogError(false);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (selectedCaps.length > 0) params.set("c", selectedCaps.join(","));
      const r = await fetch(`/api/catalog?${params}`);
      if (!r.ok) throw new Error("Failed to load catalog");
      const data = await r.json();
      if (Array.isArray(data)) setModels(data);
    } catch {
      setCatalogError(true);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [search, selectedCaps]);

  const loadVllmCatalog = useCallback(async () => {
    setVllmLoading(true);
    setVllmError(false);
    try {
      const params = new URLSearchParams({ engine: "vllm" });
      if (search) params.set("q", search);
      const r = await fetch(`/api/catalog?${params}`);
      if (!r.ok) throw new Error("Failed to load catalog");
      const data = await r.json();
      setVllmEntries(Array.isArray(data) ? data : []);
    } catch {
      setVllmError(true);
      setVllmEntries([]);
    } finally {
      setVllmLoading(false);
    }
  }, [search]);

  useEffect(() => {
    if (engine === "ollama") void loadCatalog();
  }, [engine, loadCatalog]);

  useEffect(() => {
    if (engine === "vllm") void loadVllmCatalog();
  }, [engine, loadVllmCatalog]);

  useEffect(() => {
    fetch("/api/roles")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Role[]) => setRoles(Array.isArray(data) ? data : []))
      .catch(() => setRoles([]));
  }, []);

  // Adds (or replaces) one model in the selected role's declaration for
  // `engine`, then PUTs the whole declaration back. This never installs
  // anything directly — the model shows up as drift on the Drift page,
  // and only converges once an operator's agent picks it up. Declaring the
  // same identifier again (e.g. picking a different size tag) replaces the
  // prior entry rather than duplicating it.
  const addModelToRole = useCallback(
    async (targetEngine: RuntimeKind, model: Pick<ModelDeclaration, "name" | "repo">, sizeBytes?: number) => {
      const role = roles.find((r) => r.id === selectedRoleId);
      if (!role) return;

      const identifier = model.name ?? model.repo ?? "";
      setAddingRoleFor(`${targetEngine}:${identifier}`);
      try {
        let declaration: Declaration;
        try {
          declaration = parseDeclaration(role.desiredState);
        } catch {
          declaration = { runtimes: {} };
        }

        const existingRuntime = declaration.runtimes[targetEngine];
        const otherModels = (existingRuntime?.models ?? []).filter(
          (m) => (m.name ?? m.repo) !== identifier
        );
        const nextModel: ModelDeclaration = {
          ...model,
          state: "present",
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        };

        declaration.runtimes[targetEngine] = {
          state: existingRuntime?.state ?? "present",
          version: existingRuntime?.version,
          models: [...otherModels, nextModel],
        };

        const res = await fetch(`/api/roles/${role.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ desiredState: serializeDeclaration(declaration) }),
        });

        if (!res.ok) {
          toast(t("addToRoleError"), "error");
          return;
        }

        setRoles((prev) =>
          prev.map((r) => (r.id === role.id ? { ...r, desiredState: serializeDeclaration(declaration) } : r))
        );
        toast(t("addToRoleSuccess", { name: identifier, role: role.name }), "success");
      } catch {
        toast(t("addToRoleError"), "error");
      } finally {
        setAddingRoleFor(null);
      }
    },
    [roles, selectedRoleId, t, toast]
  );

  const toggleCap = (cap: string) => {
    setSelectedCaps((prev) => prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]);
  };

  const handlePull = async (modelName: string, tag?: string) => {
    if (!selectedServer) return;
    const ref = tag ? `${modelName}:${tag}` : modelName;
    if (downloadingRefs.has(ref)) return;
    setDownloadingRefs((prev) => new Set(prev).add(ref));
    try {
      const res = await fetch("/api/admin/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name: ref }),
      });
      if (!res.ok) {
        toast(t("pullError", { name: ref }), "error");
        setDownloadingRefs((prev) => { const next = new Set(prev); next.delete(ref); return next; });
        return;
      }
      toast(t("pullStarted", { name: ref }), "success");
    } catch {
      toast(t("pullError", { name: ref }), "error");
      setDownloadingRefs((prev) => { const next = new Set(prev); next.delete(ref); return next; });
    }
  };

  const isModelTagDownloaded = (modelName: string, tag: string) => {
    const ref = `${modelName}:${tag}`;
    for (const name of downloadedModels) {
      if (name === ref || name.startsWith(`${ref}-`)) return true;
    }
    return false;
  };

  const isDownloading = (modelName: string, tag: string) =>
    downloadingRefs.has(`${modelName}:${tag}`);

  const getTagScore = (tag: string) => {
    if (!gpuSpecs) return null;
    const sizeGB = parseTagToSizeGB(tag);
    if (sizeGB === null) return null;
    return scoreModel(sizeGB, gpuSpecs.vramGB, gpuSpecs.bandwidthGBs ?? undefined);
  };

  // Flatten models × sizes into individual rows; apply GPU filter and sort by grade.
  const flatRows = useMemo(() => {
    const GRADE_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };

    const rows = models.flatMap((model) => {
      const sizes = model.sizes.length > 0 ? model.sizes : ["latest"];
      const all = sizes.map((size) => ({ ...model, size }));
      if (fitsGpuOnly && gpuSpecs) {
        return all.filter(({ size }) => {
          const sizeGB = parseTagToSizeGB(size);
          return sizeGB === null || sizeGB <= gpuSpecs.vramGB;
        });
      }
      return all;
    });

    return [...rows].sort((a, b) => {
      if (sortBy === "grade" && gpuSpecs) {
        const scoreA = getTagScore(a.size);
        const scoreB = getTagScore(b.size);
        const gradeA = scoreA ? GRADE_ORDER[scoreA.grade] ?? 6 : 6;
        const gradeB = scoreB ? GRADE_ORDER[scoreB.grade] ?? 6 : 6;
        if (gradeA !== gradeB) return (gradeA - gradeB) * sortDir;
        return ((scoreB?.tps ?? 0) - (scoreA?.tps ?? 0)) * sortDir;
      }
      // Default: sort by updated (most recent first)
      return (parseRelativeTime(b.updated) - parseRelativeTime(a.updated)) * sortDir;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, fitsGpuOnly, gpuSpecs, sortBy, sortDir]);

  const gpuLabel = gpuSpecs
    ? `${gpuSpecs.gpuName.replace(/NVIDIA GeForce /i, "").replace(/NVIDIA /i, "")} · ${Math.round(gpuSpecs.vramGB)}GB`
    : null;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {gpuLabel && (
          <span className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2.5 py-0.5 text-xs text-[hsl(var(--muted-foreground))]">
            {gpuLabel}
          </span>
        )}
      </div>

      {/* Engine + role declaration */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-[hsl(var(--border))] p-0.5" role="tablist" aria-label={t("engine")}>
          {ENGINE_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              role="tab"
              aria-selected={engine === opt}
              onClick={() => setEngine(opt)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                engine === opt
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              }`}
            >
              {t(`engines.${opt}`)}
            </button>
          ))}
        </div>

        {roles.length > 0 && (
          <Select
            value={selectedRoleId}
            onChange={(e) => setSelectedRoleId(e.target.value)}
            className="w-auto"
            aria-label={t("addToRoleLabel")}
          >
            <option value="">{t("addToRoleLabel")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {/* Search + Server */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchModels")} className="flex-1" />
        {engine === "ollama" && servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
      </div>

      {/* Capability filters + Fits GPU */}
      {engine === "ollama" && (
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by capability">
        {CAPABILITY_OPTIONS.map((cap) => (
          <button
            key={cap}
            onClick={() => toggleCap(cap)}
            aria-pressed={selectedCaps.includes(cap)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              selectedCaps.includes(cap)
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
            }`}
          >
            {t(`capabilities.${cap}`)}
          </button>
        ))}
        {gpuSpecs && (
          <button
            onClick={() => setFitsGpuOnly((v) => !v)}
            aria-pressed={fitsGpuOnly}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              fitsGpuOnly
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
            }`}
          >
            {t("fitsGpu")}
          </button>
        )}
      </div>
      )}

      {/* GPU grade legend */}
      {engine === "ollama" && gpuSpecs && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
          <span className="font-semibold text-[hsl(var(--foreground))]">GPU:</span>
          {(["S", "A", "B", "C", "D", "F"] as Grade[]).map((g) => (
            <span key={g} className="flex items-center gap-1.5">
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ color: gradeColor(g), background: gradeBg(g) }}>
                {g}
              </span>
              <span>{GRADE_LABELS[g]}</span>
            </span>
          ))}
        </div>
      )}

      {/* vLLM / HuggingFace catalog */}
      {engine === "vllm" && (
        vllmError ? (
          <EmptyState
            icon={AlertTriangle}
            title={t("loadError")}
            description={t("loadErrorDescription")}
            action={<Button onClick={loadVllmCatalog}>{tc("retry")}</Button>}
          />
        ) : vllmLoading ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-6 border-b border-[hsl(var(--border))] px-4 py-3 last:border-0">
                <div className="h-4 w-40 animate-pulse rounded bg-[hsl(var(--muted))]" />
                <div className="h-4 flex-1 animate-pulse rounded bg-[hsl(var(--muted))] opacity-30" />
              </div>
            ))}
          </div>
        ) : vllmEntries.length === 0 ? (
          <EmptyState icon={Search} title={t("emptyTitle")} description={t("emptyDescription")} />
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]" role="table" aria-label={t("title")}>
            {vllmEntries.map((entry, idx) => {
              const rowKey = `vllm:${entry.id}`;
              const isAdding = addingRoleFor === rowKey;
              return (
                <div
                  key={entry.id}
                  role="row"
                  className={`flex items-center gap-4 px-4 py-3 text-sm ${idx !== vllmEntries.length - 1 ? "border-b border-[hsl(var(--border))]" : ""}`}
                >
                  <div role="cell" className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{entry.name}</div>
                    {entry.description && (
                      <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">{entry.description}</p>
                    )}
                  </div>
                  <div role="cell" className="w-8 shrink-0 flex justify-end">
                    {isAdding ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--muted-foreground))]" />
                    ) : isAdmin ? (
                      <button
                        onClick={() => addModelToRole("vllm", { repo: entry.id }, entry.sizeBytes)}
                        disabled={!selectedRoleId}
                        aria-label={`${t("addToRole")} ${entry.name}`}
                        title={t("addToRole")}
                        className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
                      >
                        <FolderPlus className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Model list */}
      {engine === "ollama" && (catalogError ? (
        <EmptyState
          icon={AlertTriangle}
          title={t("loadError")}
          description={t("loadErrorDescription")}
          action={<Button onClick={loadCatalog}>{tc("retry")}</Button>}
        />
      ) : loading ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-6 border-b border-[hsl(var(--border))] px-4 py-3 last:border-0">
              <div className="h-4 w-40 animate-pulse rounded bg-[hsl(var(--muted))]" />
              <div className="h-4 flex-1 animate-pulse rounded bg-[hsl(var(--muted))] opacity-30" />
              <div className="h-4 w-20 animate-pulse rounded bg-[hsl(var(--muted))]" />
              <div className="h-6 w-6 animate-pulse rounded bg-[hsl(var(--muted))]" />
            </div>
          ))}
        </div>
      ) : flatRows.length === 0 ? (
        <EmptyState icon={Search} title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]" role="table" aria-label={t("title")}>
          {/* Column headers */}
          <div className="flex items-center gap-4 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.6)] px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]" role="row">
            <span className="flex-1" role="columnheader">Model</span>
            <span
              className="w-24 shrink-0 hidden sm:block text-right"
              role="columnheader"
              aria-sort={sortBy === "updated" ? (sortDir === 1 ? "descending" : "ascending") : "none"}
            >
              <button
                onClick={() => { setSortBy("updated"); setSortDir(sortBy === "updated" ? (sortDir === 1 ? -1 : 1) : 1); }}
                className={`flex w-full items-center justify-end gap-0.5 hover:text-[hsl(var(--foreground))] transition-colors ${sortBy === "updated" ? "text-[hsl(var(--foreground))]" : ""}`}
              >
                Updated <span>{sortBy === "updated" ? (sortDir === 1 ? "↓" : "↑") : <span className="opacity-30">↕</span>}</span>
              </button>
            </span>
            <span className="w-28 shrink-0 text-right" role="columnheader">Size</span>
            {gpuSpecs && <span className="w-24 shrink-0 text-right hidden md:block" role="columnheader">Speed</span>}
            {gpuSpecs && (
              <span
                className="w-16 shrink-0"
                role="columnheader"
                aria-sort={sortBy === "grade" ? (sortDir === 1 ? "descending" : "ascending") : "none"}
              >
                <button
                  onClick={() => { setSortBy("grade"); setSortDir(sortBy === "grade" ? (sortDir === 1 ? -1 : 1) : 1); }}
                  className={`flex w-full items-center justify-center whitespace-nowrap hover:text-[hsl(var(--foreground))] transition-colors ${sortBy === "grade" ? "text-[hsl(var(--foreground))]" : ""}`}
                >
                  Grade <span>{sortBy === "grade" ? (sortDir === 1 ? "↓" : "↑") : <span className="opacity-30">↕</span>}</span>
                </button>
              </span>
            )}
            <span className="w-8 shrink-0" role="columnheader" />
          </div>

          {flatRows.map((row, idx) => {
            const downloaded = isModelTagDownloaded(row.name, row.size);
            const pulling = isDownloading(row.name, row.size);
            const score = getTagScore(row.size);
            const sizeGB = parseTagToSizeGB(row.size);
            const gbLabel = sizeGB != null
              ? sizeGB < 10 ? `${sizeGB.toFixed(1)} GB` : `${Math.round(sizeGB)} GB`
              : null;
            const noFit = score && !score.fits;
            const isLast = idx === flatRows.length - 1;

            const rowInner = (
              <div
                key={`${row.id}-${row.size}`}
                role="row"
                className={[
                  "flex items-center gap-4 px-4 py-3 text-sm",
                  noFit ? "opacity-40" : "",
                  !isLast ? "border-b border-[hsl(var(--border))]" : "",
                ].join(" ")}>
                {/* Name + size tag + capability icons */}
                <div role="cell" className="min-w-0 flex-1 flex items-center gap-3">
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{row.name}</span>
                    <span className="shrink-0 rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-[11px] text-[hsl(var(--muted-foreground))]">
                      {row.size}
                    </span>
                  </div>
                  <CapabilityIcons capabilities={row.capabilities} className="shrink-0" />
                </div>

                {/* Updated */}
                <span role="cell" className="w-24 shrink-0 text-right text-xs text-[hsl(var(--muted-foreground))] hidden sm:block">
                  {row.updated}
                </span>

                {/* GB + VRAM% */}
                <div role="cell" className="w-28 shrink-0 flex items-center justify-end gap-1.5">
                  {gbLabel && <span className="tabular-nums">{gbLabel}</span>}
                  {score && gpuSpecs && (
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums" style={vramStyle(score.memPct)}>
                      {Math.round(score.memPct)}%
                    </span>
                  )}
                </div>

                {/* Speed */}
                {gpuSpecs && (
                  <div role="cell" className="w-24 shrink-0 text-right text-sm tabular-nums hidden md:block">
                    {score?.fits && score.tps > 0 ? (
                      <span style={{ color: gradeColor(score.grade) }}>~{Math.round(score.tps)} t/s</span>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </div>
                )}

                {/* Grade */}
                {gpuSpecs && (
                  <div role="cell" className="w-16 shrink-0 flex justify-center">
                    {score ? (
                      <span className="text-xl font-bold leading-none" style={{ color: gradeColor(score.grade) }}>
                        {score.grade}
                      </span>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </div>
                )}

                {/* Action */}
                <div role="cell" className="flex w-16 shrink-0 items-center justify-end gap-1">
                  {downloaded ? (
                    <Check
                      role="img"
                      aria-label={`${t("downloaded")}: ${row.name}:${row.size}`}
                      className="h-4 w-4 text-[hsl(142_71%_45%)]"
                    />
                  ) : pulling ? (
                    <Loader2
                      role="img"
                      aria-label={`${t("downloading")}: ${row.name}:${row.size}`}
                      className="h-4 w-4 animate-spin text-[hsl(var(--muted-foreground))]"
                    />
                  ) : isAdmin ? (
                    <button
                      onClick={() => handlePull(row.name, row.size !== "latest" ? row.size : undefined)}
                      disabled={!selectedServer}
                      aria-label={`${t("pullModel")} ${row.name}:${row.size}`}
                      title={t("pullModel")}
                      className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  ) : null}
                  {isAdmin &&
                    (addingRoleFor === `ollama:${row.name}${row.size !== "latest" ? `:${row.size}` : ""}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--muted-foreground))]" />
                    ) : (
                      <button
                        onClick={() =>
                          addModelToRole(
                            "ollama",
                            { name: row.size !== "latest" ? `${row.name}:${row.size}` : row.name },
                            estimateSizeBytesFromTag(row.size)
                          )
                        }
                        disabled={!selectedRoleId}
                        aria-label={`${t("addToRole")} ${row.name}:${row.size}`}
                        title={t("addToRole")}
                        className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
                      >
                        <FolderPlus className="h-4 w-4" />
                      </button>
                    ))}
                </div>
              </div>
            );

            return rowInner;
          })}
        </div>
      ))}
    </div>
  );
}
