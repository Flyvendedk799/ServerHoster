import { useEffect, useState } from "react";
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

export function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKind, setWebhookKind] = useState<"discord" | "slack">("discord");

  async function load(): Promise<void> {
    try {
      const res = await api<{ items: Notification[]; unread: number }>("/notifications", { silent: true });
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      /* silent */
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

      <section className="card featured-form" style={{ marginBottom: "3rem" }}>
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
        {items.length === 0 ? (
          <div className="muted italic text-center" style={{ padding: "4rem" }}>
            Your inbox is clear. No recent system alerts.
          </div>
        ) : (
          <div className="notification-list">
            {items.map((n) => (
              <div key={n.id} className={`notification-item row ${n.read ? "read" : "unread"}`}>
                <div className="severity-bar" style={{ background: SEVERITY_COLOR[n.severity] }} />
                <div className="content" style={{ flex: 1 }}>
                  <div className="row between">
                    <h4 className="font-semibold">{n.title}</h4>
                    <span className="tiny muted">{new Date(n.created_at).toLocaleTimeString()}</span>
                  </div>
                  {n.body && <p className="muted small">{n.body}</p>}
                  <div className="row tiny muted" style={{ marginTop: "0.5rem", gap: "0.5rem" }}>
                    <span className="chip xsmall uppercase">{n.kind}</span>
                    <span>&bull;</span>
                    <span>{new Date(n.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                {!n.read && (
                  <button className="ghost tiny" onClick={() => markRead(n.id)}>
                    Mark Read
                  </button>
                )}
              </div>
            ))}
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
