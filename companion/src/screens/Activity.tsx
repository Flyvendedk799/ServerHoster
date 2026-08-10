import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import { ServerSwitcher } from "../components/ServerSwitcher";
import { useSummary } from "../hooks/useSummary";
import { useVault } from "../hooks/useVault";
import { markAllNotificationsRead, markNotificationRead } from "../lib/client";
import { describeError } from "../lib/pairing";
import { relativeTime } from "../lib/format";
import { toast } from "../lib/toast";

/** Deploys and alerts — what the machine did while you weren't looking. */
export function ActivityScreen() {
  const { active } = useVault();
  const navigate = useNavigate();
  const { data, error, loading, refresh } = useSummary(active);
  const [busy, setBusy] = useState(false);

  async function readAll(): Promise<void> {
    if (!active || busy) return;
    setBusy(true);
    try {
      await markAllNotificationsRead(active);
      refresh();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function read(id: string): Promise<void> {
    if (!active) return;
    try {
      await markNotificationRead(active, id);
      refresh();
    } catch (err) {
      toast.error(describeError(err));
    }
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <ServerSwitcher />
        {(data?.unreadNotifications ?? 0) > 0 && (
          <button className="ghost small" onClick={() => void readAll()} disabled={busy}>
            Mark all read
          </button>
        )}
      </header>

      {error && <p className="notice notice-warn">{error}</p>}

      <section>
        <h2 className="section-title">
          Alerts
          {(data?.unreadNotifications ?? 0) > 0 && <span className="badge">{data?.unreadNotifications}</span>}
        </h2>
        {loading && !data ? (
          <div className="skeleton" style={{ height: 72 }} />
        ) : (data?.notifications.length ?? 0) === 0 ? (
          <p className="muted small">Nothing to report.</p>
        ) : (
          <ul className="list">
            {data?.notifications.map((item) => (
              <li key={item.id}>
                <button
                  className={item.read ? "row-button" : "row-button unread"}
                  onClick={() => {
                    if (!item.read) void read(item.id);
                    if (item.serviceId) navigate(`/services/${item.serviceId}`);
                  }}
                >
                  <div className="row-main">
                    <span className="row-title">{item.title}</span>
                    {item.body && <span className="muted tiny clamp">{item.body}</span>}
                    <span className="muted tiny">{relativeTime(item.createdAt)}</span>
                  </div>
                  <span className={`sev sev-${item.severity}`}>{item.severity}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="section-title">Deploys</h2>
        {(data?.deployments.length ?? 0) === 0 ? (
          <p className="muted small">No deploys recorded.</p>
        ) : (
          <ul className="list">
            {data?.deployments.map((deployment) => (
              <li key={deployment.id}>
                <button className="row-button" onClick={() => navigate(`/services/${deployment.serviceId}`)}>
                  <div className="row-main">
                    <span className="row-title">{deployment.serviceName ?? "Deleted service"}</span>
                    <span className="muted tiny">
                      {relativeTime(deployment.createdAt)}
                      {deployment.commitHash ? ` · ${deployment.commitHash.slice(0, 7)}` : ""}
                    </span>
                  </div>
                  <StatusPill status={deployment.status} small />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
