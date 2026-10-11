"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useCallback } from "react";
import { GitCompare, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
// The route's own types, not hand-written copies of them. A local interface
// that `tsc` never checks against the real payload is exactly how a Critical
// /api/logs regression survived five clean reviews earlier on this branch:
// the page kept compiling against a shape the route had stopped returning.
import type { DriftState, HostDrift, RuntimeDrift } from "@/lib/drift";
import { parseDeclaration } from "@/lib/desired-state";

// Only the fields the banner check reads from a role.
interface RoleSummary {
  name: string;
  desiredState: string;
}

interface UpstreamBanner {
  latest: string;
  roleName: string;
  pin: string;
}

type RunStatus =
  | "no_changes"
  | "vetoed"
  | "vetoed_remote"
  | "dry_run"
  | "busy"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cooling_down";

// One entry per action the agent attempted or blocked in its most recent
// run, as stored by the checkin route (see `buildStoredActions`). Only the
// fields the drift page reads are declared here.
interface ConvergenceRunAction {
  kind?: string;
  runtime?: string;
  model_name?: string;
  model_repo?: string;
  blocked?: boolean;
  shortfall_bytes?: number;
}

interface ConvergenceRunSummary {
  nodeName: string;
  status: RunStatus;
  startedAt: string;
  error: string | null;
  actions?: ConvergenceRunAction[];
}

const STATE_BADGE_VARIANT: Record<DriftState, BadgeProps["variant"]> = {
  in_sync: "success",
  drifted: "warning",
  blocked: "destructive",
  unmanaged: "muted",
  stale: "default",
};

const RUN_STATUS_BADGE_VARIANT: Record<RunStatus, BadgeProps["variant"]> = {
  succeeded: "success",
  failed: "destructive",
  busy: "warning",
  vetoed: "warning",
  vetoed_remote: "warning",
  dry_run: "muted",
  no_changes: "muted",
  blocked: "destructive",
  // Not "destructive": a cooling-down run is the agent deliberately waiting
  // out an earlier failure rather than a new failure of its own. The failure
  // itself is still visible on the run that produced it.
  cooling_down: "warning",
};

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function DriftPage() {
  const t = useTranslations("admin.drift");
  const tc = useTranslations("common");

  const [hosts, setHosts] = useState<HostDrift[]>([]);
  const [lastRuns, setLastRuns] = useState<Record<string, ConvergenceRunSummary>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [upstreamBanner, setUpstreamBanner] = useState<UpstreamBanner | null>(null);

  const fetchDrift = useCallback(async () => {
    setLoading(true);
    try {
      const [driftRes, runsRes] = await Promise.all([
        fetch("/api/drift"),
        fetch("/api/convergence"),
      ]);
      if (!driftRes.ok) throw new Error("Failed to fetch drift");
      const data = await driftRes.json();
      setHosts(data);

      // /api/convergence returns runs newest-first across the fleet; the
      // first run seen per node is therefore its most recent one. A failed
      // fetch here degrades to "no last run" rather than blanking the whole
      // drift table — the drift verdict itself is the primary signal.
      if (runsRes.ok) {
        const runs: ConvergenceRunSummary[] = await runsRes.json();
        const latest: Record<string, ConvergenceRunSummary> = {};
        for (const run of runs) {
          if (!(run.nodeName in latest)) {
            latest[run.nodeName] = run;
          }
        }
        setLastRuns(latest);
      } else {
        setLastRuns({});
      }

      setError(false);
    } catch {
      setHosts([]);
      setLastRuns({});
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Independent of fetchDrift: an unreachable or slow upstream check must
  // never block or fail the drift table itself, which is the page's
  // primary signal.
  const fetchUpstreamBanner = useCallback(async () => {
    try {
      const [rolesRes, upstreamRes] = await Promise.all([fetch("/api/roles"), fetch("/api/upstream")]);
      if (!rolesRes.ok || !upstreamRes.ok) {
        setUpstreamBanner(null);
        return;
      }
      const roles: RoleSummary[] = await rolesRes.json();
      const data = await upstreamRes.json();
      const latest: string | undefined = data?.ollama?.latest;
      if (!latest) {
        setUpstreamBanner(null);
        return;
      }

      for (const role of roles) {
        let pin: string | undefined;
        try {
          pin = parseDeclaration(role.desiredState).runtimes.ollama?.version;
        } catch {
          continue;
        }
        if (pin && pin !== latest) {
          setUpstreamBanner({ latest, roleName: role.name, pin });
          return;
        }
      }
      setUpstreamBanner(null);
    } catch {
      setUpstreamBanner(null);
    }
  }, []);

  useEffect(() => {
    fetchDrift();
    fetchUpstreamBanner();
  }, [fetchDrift, fetchUpstreamBanner]);

  const stateLabel = (state: DriftState) => {
    switch (state) {
      case "in_sync":
        return t("stateInSync");
      case "drifted":
        return t("stateDrifted");
      case "blocked":
        return t("stateBlocked");
      case "unmanaged":
        return t("stateUnmanaged");
      case "stale":
        return t("stateStale");
    }
  };

  const runStatusLabel = (status: RunStatus) => {
    switch (status) {
      case "succeeded":
        return t("runSucceeded");
      case "failed":
        return t("runFailed");
      case "busy":
        return t("runBusy");
      case "vetoed":
        return t("runVetoed");
      case "vetoed_remote":
        return t("runVetoedRemote");
      case "dry_run":
        return t("runDryRun");
      case "no_changes":
        return t("runNoChanges");
      case "blocked":
        return t("runBlocked");
      case "cooling_down":
        return t("runCoolingDown");
    }
  };

  const renderLastRun = (nodeName: string) => {
    const run = lastRuns[nodeName];
    if (!run) {
      return <span className="text-xs text-[hsl(var(--muted-foreground))]">{t("noRuns")}</span>;
    }
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Badge variant={RUN_STATUS_BADGE_VARIANT[run.status]}>{runStatusLabel(run.status)}</Badge>
          <span className="whitespace-nowrap text-xs text-[hsl(var(--muted-foreground))]">
            {new Date(run.startedAt).toLocaleString()}
          </span>
        </div>
        {run.status === "failed" && run.error ? (
          <p className="max-w-xs text-xs text-[hsl(var(--destructive))]">{run.error}</p>
        ) : null}
      </div>
    );
  };

  // A model that is declared present but not yet installed shows as
  // "drifted" — computeDrift has no disk information, so it cannot know
  // whether a pull for it would fit. Cross-reference the host's most
  // recent convergence run: if the agent already tried this exact pull and
  // its disk check failed, show "blocked" with the shortfall instead of a
  // bare "drifted" that gives the operator no actionable number.
  const blockedShortfall = (nodeName: string, runtimeKind: string, modelName: string) => {
    const actions = lastRuns[nodeName]?.actions ?? [];
    const match = actions.find(
      (a) =>
        a.kind === "pull_model" &&
        a.runtime === runtimeKind &&
        a.blocked === true &&
        (a.model_name === modelName || a.model_repo === modelName)
    );
    return match?.shortfall_bytes;
  };

  const renderModels = (nodeName: string, runtime: RuntimeDrift) => {
    if (runtime.models.length === 0) {
      return <span className="text-xs text-[hsl(var(--muted-foreground))]">{t("noModelsDeclared")}</span>;
    }
    return (
      <div className="flex flex-col gap-1">
        {runtime.models.map((model) => {
          const shortfall = model.state === "drifted" ? blockedShortfall(nodeName, runtime.kind, model.name) : undefined;
          const effectiveState: DriftState = shortfall !== undefined ? "blocked" : model.state;
          return (
            <div key={model.name} className="flex items-center gap-1.5">
              <Badge variant={STATE_BADGE_VARIANT[effectiveState]}>{stateLabel(effectiveState)}</Badge>
              <span className="truncate text-xs">{model.name}</span>
              {effectiveState === "unmanaged" && (
                <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                  ({t("modelUnmanagedHint")})
                </span>
              )}
              {shortfall !== undefined && (
                <span className="whitespace-nowrap text-[10px] text-[hsl(var(--destructive))]">
                  {t("shortfallBy", { amount: formatBytes(shortfall) })}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-5 p-6">
        <div>
          <Skeleton variant="line" className="mb-2 h-8 w-32" />
          <Skeleton variant="line" className="h-4 w-64" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} variant="row" className="h-16" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{t("subtitle")}</p>
      </div>

      {upstreamBanner && (
        <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-2 text-sm">
          {t("upstreamBanner", {
            latest: upstreamBanner.latest,
            name: upstreamBanner.roleName,
            pin: upstreamBanner.pin,
          })}
        </div>
      )}

      {error ? (
        <EmptyState
          icon={AlertTriangle}
          title={t("errorTitle")}
          description={t("errorDescription")}
          action={<Button onClick={fetchDrift}>{tc("retry")}</Button>}
        />
      ) : hosts.length === 0 ? (
        <EmptyState
          icon={GitCompare}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
        />
      ) : (
        <Table caption={t("title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colNode")}</TableHead>
              <TableHead>{t("colRuntime")}</TableHead>
              <TableHead>{t("colState")}</TableHead>
              <TableHead>{t("colDesired")}</TableHead>
              <TableHead>{t("colActual")}</TableHead>
              <TableHead>{t("colModels")}</TableHead>
              <TableHead>{t("colReason")}</TableHead>
              <TableHead>{t("colLastRun")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hosts.map((host) =>
              host.runtimes.length === 0 ? (
                <TableRow key={host.nodeName}>
                  <TableCell className="font-medium">{host.nodeName}</TableCell>
                  <TableCell className="text-xs text-[hsl(var(--muted-foreground))]">
                    {t("noDeclaredRuntimes")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATE_BADGE_VARIANT[host.state]}>
                      {stateLabel(host.state)}
                    </Badge>
                  </TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>{renderLastRun(host.nodeName)}</TableCell>
                </TableRow>
              ) : (
                host.runtimes.map((runtime, index) => (
                  <TableRow key={`${host.nodeName}-${runtime.kind}`}>
                    <TableCell className="font-medium">
                      {index === 0 ? host.nodeName : ""}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{runtime.kind}</TableCell>
                    <TableCell>
                      <Badge variant={STATE_BADGE_VARIANT[runtime.state]}>
                        {stateLabel(runtime.state)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {runtime.desiredVersion ?? t("any")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {runtime.actualVersion ?? t("unknown")}
                    </TableCell>
                    <TableCell className="min-w-[10rem]">{renderModels(host.nodeName, runtime)}</TableCell>
                    <TableCell className="max-w-xs text-xs text-[hsl(var(--muted-foreground))]">
                      {runtime.reason ?? "—"}
                    </TableCell>
                    <TableCell>{index === 0 ? renderLastRun(host.nodeName) : ""}</TableCell>
                  </TableRow>
                ))
              )
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
