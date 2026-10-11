"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useCallback } from "react";
import { HardDrive, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
import { useToast } from "@/components/ui/toast";

interface Gpu {
  id: string;
  index: number;
  vendor: string;
  name: string;
  memoryTotalBytes: number | null;
  memorySource: string;
  driverStatus: string;
}

interface Runtime {
  id: string;
  kind: string;
  version: string | null;
  serviceState: string | null;
}

interface Host {
  id: string;
  nodeName: string;
  arch: string;
  os: string;
  cpuModel: string | null;
  cpuCount: number | null;
  ramTotalBytes: number | null;
  approvalState: string;
  lastCheckInAt: string | null;
  roleId: string | null;
  converge: boolean;
  gpus: Gpu[];
  runtimes: Runtime[];
}

interface Role {
  id: string;
  name: string;
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  const gb = bytes / 1024 ** 3;
  if (gb < 1) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${gb.toFixed(1)} GB`;
}

export default function HostsPage() {
  const t = useTranslations("admin.hosts");
  const tc = useTranslations("common");
  const { toast } = useToast();

  const [hosts, setHosts] = useState<Host[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);
  const [updatingConvergeId, setUpdatingConvergeId] = useState<string | null>(null);

  const fetchHosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/hosts");
      if (!res.ok) throw new Error("Failed to fetch hosts");
      const data = await res.json();
      setHosts(data);
      setError(false);
    } catch {
      setHosts([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch("/api/roles");
      if (!res.ok) throw new Error("Failed to fetch roles");
      const data = await res.json();
      setRoles(data);
    } catch {
      setRoles([]);
    }
  }, []);

  useEffect(() => {
    fetchHosts();
    fetchRoles();
  }, [fetchHosts, fetchRoles]);

  const handleApprove = async (host: Host) => {
    setApprovingId(host.id);
    try {
      const res = await fetch(`/api/hosts/${host.id}/approve`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to approve host");
      toast(t("approveSuccess"), "success");
      await fetchHosts();
    } catch {
      toast(t("approveError"), "error");
    } finally {
      setApprovingId(null);
    }
  };

  const handleRoleChange = async (host: Host, roleId: string) => {
    setUpdatingRoleId(host.id);
    try {
      const res = await fetch(`/api/hosts/${host.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleId: roleId || null }),
      });
      if (!res.ok) throw new Error("Failed to update role");
      toast(t("roleAssigned"), "success");
      await fetchHosts();
    } catch {
      toast(t("roleAssignError"), "error");
    } finally {
      setUpdatingRoleId(null);
    }
  };

  const handleConvergeChange = async (host: Host, converge: boolean) => {
    setUpdatingConvergeId(host.id);
    try {
      const res = await fetch(`/api/hosts/${host.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ converge }),
      });
      if (!res.ok) throw new Error("Failed to update converge");
      toast(t("convergeUpdated"), "success");
      await fetchHosts();
    } catch {
      toast(t("convergeUpdateError"), "error");
    } finally {
      setUpdatingConvergeId(null);
    }
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

      {error ? (
        <EmptyState
          icon={AlertTriangle}
          title={t("errorTitle")}
          description={t("errorDescription")}
          action={<Button onClick={fetchHosts}>{tc("retry")}</Button>}
        />
      ) : hosts.length === 0 ? (
        <EmptyState
          icon={HardDrive}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
        />
      ) : (
        <Table caption={t("title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colNode")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead>{t("colArch")}</TableHead>
              <TableHead>{t("colCpu")}</TableHead>
              <TableHead>{t("colRam")}</TableHead>
              <TableHead>{t("colGpu")}</TableHead>
              <TableHead>{t("colRuntimes")}</TableHead>
              <TableHead>{t("colRole")}</TableHead>
              <TableHead>{t("converge")}</TableHead>
              <TableHead>{t("colLastCheckIn")}</TableHead>
              <TableHead>{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hosts.map((host) => {
              const isPending = host.approvalState !== "approved";
              return (
                <TableRow key={host.id}>
                  <TableCell className="font-medium">
                    <div>{host.nodeName}</div>
                    <div className="text-xs text-[hsl(var(--muted-foreground))]">{host.os}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={isPending ? "warning" : "success"}>
                      {isPending ? t("statusPending") : t("statusApproved")}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{host.arch}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {host.cpuModel
                      ? `${host.cpuModel}${host.cpuCount ? ` ×${host.cpuCount}` : ""}`
                      : t("unknown")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatBytes(host.ramTotalBytes) ?? t("unknown")}
                  </TableCell>
                  <TableCell>
                    {host.gpus.length === 0 ? (
                      <span className="text-xs text-[hsl(var(--muted-foreground))]">
                        {t("noGpus")}
                      </span>
                    ) : (
                      <div className="space-y-1">
                        {host.gpus.map((gpu) => {
                          const driverFailed = gpu.driverStatus === "failed";
                          return (
                            <div
                              key={gpu.id}
                              className={`flex flex-wrap items-center gap-1.5 text-xs ${
                                driverFailed ? "text-[hsl(var(--destructive))]" : ""
                              }`}
                            >
                              <span>{gpu.name}</span>
                              {driverFailed ? (
                                <Badge variant="destructive">{t("driverFailed")}</Badge>
                              ) : (
                                <span className="text-[hsl(var(--muted-foreground))]">
                                  {formatBytes(gpu.memoryTotalBytes) ?? t("unknown")}
                                  {gpu.memorySource === "unified" && (
                                    <span
                                      className="ml-1 rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]"
                                      title={t("unifiedMemoryTitle")}
                                    >
                                      {t("unifiedMemoryLabel")}
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {host.runtimes.length === 0 ? (
                      <span className="text-xs text-[hsl(var(--muted-foreground))]">
                        {t("noRuntimes")}
                      </span>
                    ) : (
                      <div className="space-y-1">
                        {host.runtimes.map((rt) => (
                          <div key={rt.id} className="whitespace-nowrap text-xs">
                            {rt.kind} {rt.version ? `v${rt.version}` : t("unknown")}
                          </div>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="min-w-[10rem]">
                    <Select
                      aria-label={t("colRole")}
                      value={host.roleId ?? ""}
                      disabled={updatingRoleId === host.id}
                      onChange={(e) => handleRoleChange(host, e.target.value)}
                    >
                      <option value="">{t("noRole")}</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={t("converge")}
                      checked={host.converge}
                      disabled={updatingConvergeId === host.id}
                      onChange={(e) => handleConvergeChange(host, e.target.checked)}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-[hsl(var(--muted-foreground))]">
                    {host.lastCheckInAt
                      ? new Date(host.lastCheckInAt).toLocaleString()
                      : t("never")}
                  </TableCell>
                  <TableCell>
                    {isPending && (
                      <Button
                        size="sm"
                        onClick={() => handleApprove(host)}
                        loading={approvingId === host.id}
                      >
                        {t("approve")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
