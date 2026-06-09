import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  AlertCircle,
  XCircle,
  RotateCw
} from "lucide-react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";

type Notification = {
  id: string;
  kind: string;
  severity: "info" | "success" | "warning" | "error";
  title: string;
  body: string | null;
  read: number;
  created_at: string;
};

const SEVERITY_COLOR: Record<Notification["severity"], string> = {
  success: "var(--success)",
  info: "var(--info)",
  warning: "var(--warning)",
  error: "var(--danger)"
};

const SEVERITY_ICON: Record<Notification["severity"], typeof Info> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertCircle,
  error: XCircle
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKind, setWebhookKind] = useState<"discord" | "slack">("discord");

  async function load(): Promise<void> {
    try {
      const res = await api<{ items: Notification[]; unread: number }>("/notifications", { silent: true });
      setItems(res.items);
      setUnread(res.unread);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload === "object" && payload && (payload as any).type === "notification") void load();
    });
    return () => ws.close();
  }, []);

  async function markRead(id: string): Promise<void> {
    try {
      await api(`/notifications/${id}/read`, { method: "POST" });
      await load();
    } catch {
      /* toasted */
    }
  }

  async function readAll(): Promise<void> {
    try {
      await api("/notifications/read-all", { method: "POST" });
      toast.success("All notifications marked read");
      await load();
    } catch {
      /* toasted */
    }
  }

  async function saveWebhook(): Promise<void> {
    if (!webhookUrl) return;
    try {
      await api("/notifications/webhook", {
        method: "PUT",
        body: JSON.stringify({ url: webhookUrl, kind: webhookKind })
      });
      toast.success("Webhook connected");
      setWebhookUrl("");
    } catch {
      /* toasted */
    }
  }

  return (
    <div className="notifications-page">
      <header className="page-header">
        <h2>Event Stream</h2>
        <div className="row">
          <span className={`chip ${unread > 0 ? "active-alert" : ""}`}>{unread} Unread Alerts</span>
          {unread > 0 && (
            <button className="ghost xsmall" onClick={readAll}>
              Mark All Read
            </button>
          )}
        </div>
      </header>

      <section className="card featured-form">
        <div className="section-title">
          <h3>Outgoing Webhooks</h3>
        </div>
        <p className="muted small" style={{ marginBottom: "1rem" }}>
          Stream critical alerts to external team channels.
        </p>
        <div className="row" style={{ gap: "1rem" }}>
          <select
            value={webhookKind}
            onChange={(e) => setWebhookKind(e.target.value as any)}
            style={{ width: "120px" }}
          >
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
          </select>
          <input
            placeholder="https://..."
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={saveWebhook}>
            Connect Hub
          </button>
        </div>
      </section>

      <section className="card list-container" style={{ padding: 0 }}>
        {items.length === 0 && loadError ? (
          <div className="empty-state is-error">
            <AlertTriangle size={28} className="text-danger" />
            <p>Could not reach the notification service.</p>
            <button className="ghost small" onClick={() => void load()}>
              <RotateCw size={14} /> Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="muted italic text-center empty-state-card">
            Your inbox is clear. No recent system alerts.
          </div>
        ) : (
          <div className="notification-list">
            {items.map((n) => {
              const SeverityIcon = SEVERITY_ICON[n.severity];
              return (
                <div key={n.id} className={`notification-item row ${n.read ? "read" : "unread"}`}>
                  <div className="severity-bar" style={{ background: SEVERITY_COLOR[n.severity] }} />
                  <SeverityIcon
                    size={18}
                    style={{ color: SEVERITY_COLOR[n.severity], flexShrink: 0, marginTop: "2px" }}
                  />
                  <div className="content" style={{ flex: 1 }}>
                    <div className="row between">
                      <h4 className="font-semibold">{n.title}</h4>
                      <span className="tiny muted">{relativeTime(n.created_at)}</span>
                    </div>
                    {n.body && <p className="muted small">{n.body}</p>}
                    <div className="row tiny muted" style={{ marginTop: "0.5rem", gap: "0.5rem" }}>
                      <span className="chip xsmall uppercase">{n.kind}</span>
                    </div>
                  </div>
                  {!n.read && (
                    <button className="ghost tiny" onClick={() => markRead(n.id)}>
                      Mark Read
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .notifications-page .active-alert { background: var(--danger-soft); color: var(--danger); border-color: var(--danger); }
        .notifications-page .notification-list { display: flex; flex-direction: column; }
        .notifications-page .notification-item { 
          padding: 1.25rem; 
          border-bottom: 1px solid var(--border-subtle); 
          gap: 1.25rem;
          transition: var(--transition);
        }
        .notifications-page .notification-item:last-child { border-bottom: none; }
        .notifications-page .notification-item.unread { background: var(--bg-glass); }
        .notifications-page .notification-item.read { opacity: 0.6; }
        .notifications-page .severity-bar { width: 4px; height: 100%; min-height: 40px; border-radius: 2px; flex-shrink: 0; }
        .notifications-page .font-semibold { font-weight: 600; margin: 0; }
        .notifications-page .xsmall { font-size: 0.65rem; padding: 0.1rem 0.4rem; }
      `
        }}
      />
    </div>
  );
}
