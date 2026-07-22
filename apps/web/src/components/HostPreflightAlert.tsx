import { useEffect, useState } from "react";
import { AlertTriangle, Copy, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

/**
 * Surfaces what a service needs from the HOST that isn't installed.
 *
 * Process services run directly on the box, so a missing runtime shows up as an
 * opaque `spawn pnpm ENOENT` partway through a build. This turns that into a
 * named list with the exact install command, which matters most right after
 * moving a project onto a fresh server.
 *
 * Renders nothing when everything is satisfied — it should be invisible on a
 * healthy host, not another permanent banner to scroll past.
 */
export type HostRequirementResult = {
  id: string;
  label: string;
  satisfied: boolean;
  detected?: string;
  reason?: string;
  install?: string;
  optional?: boolean;
  source: "manifest" | "detected";
};

export type HostPreflightReport = {
  ok: boolean;
  missingRequired: HostRequirementResult[];
  results: HostRequirementResult[];
  reason?: string;
};

export function HostPreflightAlert({ serviceId }: { serviceId: string }) {
  const [report, setReport] = useState<HostPreflightReport | null>(null);
  const [checking, setChecking] = useState(false);

  const load = (): void => {
    setChecking(true);
    // silent: this is a background probe; a failure here must not toast over the
    // service list, and an older server without the route simply returns 404.
    api<HostPreflightReport>(`/services/${serviceId}/preflight`, { silent: true })
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setChecking(false));
  };

  useEffect(() => {
    let cancelled = false;
    api<HostPreflightReport>(`/services/${serviceId}/preflight`, { silent: true })
      .then((result) => {
        if (!cancelled) setReport(result);
      })
      .catch(() => {
        /* older server or service not deployed yet — stay silent */
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  const missing = report?.missingRequired ?? [];
  if (!report || report.ok || missing.length === 0) return null;

  const copy = (text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Install command copied"))
      .catch(() => toast.error("Could not copy to clipboard"));
  };

  const installAll = missing
    .map((item) => item.install)
    .filter((cmd): cmd is string => Boolean(cmd))
    .join(" && ");

  return (
    <div className="alert alert-amber host-preflight">
      <AlertTriangle size={14} />
      <div className="host-preflight-body">
        <div className="alert-title">
          {missing.length} host requirement{missing.length === 1 ? "" : "s"} missing on this server
        </div>
        <p className="host-preflight-lead">
          This service runs directly on the host. Until these are installed it will build but is
          likely to fail on start.
        </p>

        <ul className="host-preflight-list">
          {missing.map((item) => (
            <li key={item.id}>
              <div className="host-preflight-name">
                <strong>{item.label}</strong>
                {item.reason && <span className="host-preflight-reason"> — {item.reason}</span>}
                {item.source === "detected" && <span className="host-preflight-tag">auto-detected</span>}
              </div>
              {item.install && (
                <div className="host-preflight-cmd">
                  <code>{item.install}</code>
                  <button
                    className="ghost xsmall"
                    onClick={() => copy(item.install as string)}
                    aria-label={`Copy install command for ${item.label}`}
                    data-tooltip="Copy install command"
                  >
                    <Copy size={12} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="host-preflight-actions">
          {installAll && (
            <button className="ghost xsmall" onClick={() => copy(installAll)}>
              <Copy size={12} /> Copy all install commands
            </button>
          )}
          <button className="ghost xsmall" onClick={load} disabled={checking}>
            <RefreshCw size={12} /> {checking ? "Re-checking…" : "Re-check"}
          </button>
        </div>
      </div>
    </div>
  );
}
