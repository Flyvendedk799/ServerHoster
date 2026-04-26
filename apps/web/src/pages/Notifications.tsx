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
  service_id: string | null;
  read: number;
  created_at: string;
};

const SEVERITY_COLOR: Record<Notification["severity"], string> = {
  success: "#10b981",
  info: "#3b82f6",
  warning: "#f59e0b",
  error: "#ef4444"
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
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string };
      if (typed.type === "notification") void load();
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
      toast.success("Notification webhook saved");
      setWebhookUrl("");
    } catch {
      /* toasted */
    }
  }

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-6)" }}>
        <h2 style={{ margin: 0 }}>Notifications</h2>
        <div className="row">
           <span className="chip" style={{ background: unread > 0 ? "var(--danger-soft)" : "var(--bg-sunken)", color: unread > 0 ? "var(--danger)" : "var(--text-dim)" }}>
             {unread} Unread
           </span>
           <button className="ghost" onClick={() => void readAll()} disabled={unread === 0}>Mark all read</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-8)" }}>
        <h3>External Forwarding</h3>
        <p className="gh-hint" style={{ marginBottom: "var(--space-4)" }}>
          Sync platform alerts to Discord or Slack.
        </p>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <select value={webhookKind} onChange={(e) => setWebhookKind(e.target.value as any)} style={{ width: "140px" }}>
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
          </select>
          <input
            placeholder="Webhook URL (https://...)"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={() => void saveWebhook()}>Connect</button>
        </div>
      </div>

      <div className="card elevated" style={{ padding: "0" }}>
        {items.length === 0 ? (
          <p style={{ color: "var(--text-dim)", textAlign: "center", padding: "var(--space-8)" }}>No alerts at this time.</p>
        ) : (
          <div style={{ display: "grid" }}>
            {items.map((n) => (
              <div
                key={n.id}
                className="row"
                style={{
                  padding: "var(--space-4)",
                  borderBottom: "1px solid var(--border-subtle)",
                  gap: "var(--space-4)",
                  alignItems: "flex-start",
                  opacity: n.read ? 0.7 : 1,
                  background: n.read ? "transparent" : "rgba(255, 255, 255, 0.02)",
                  transition: "background 0.2s ease"
                }}
              >
                <div style={{ 
                  marginTop: "0.25rem",
                  width: "12px", 
                  height: "12px", 
                  borderRadius: "50%", 
                  background: SEVERITY_COLOR[n.severity],
                  boxShadow: n.read ? "none" : `0 0 10px ${SEVERITY_COLOR[n.severity]}`
                }} />
                
                <div style={{ flex: 1 }}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.2rem" }}>
                    <div style={{ fontWeight: 600, color: n.read ? "var(--text-secondary)" : "var(--text-primary)" }}>{n.title}</div>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>
                      {new Date(n.created_at).toLocaleString()}
                    </div>
                  </div>
                  
                  {n.body && <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>{n.body}</div>}
                  
                  <div className="row" style={{ gap: "0.5rem" }}>
                    <span className="chip" style={{ fontSize: "0.65rem", textTransform: "uppercase" }}>{n.kind}</span>
                    <span className="chip" style={{ fontSize: "0.65rem", textTransform: "uppercase" }}>{n.severity}</span>
                  </div>
                </div>

                {!n.read && (
                  <button className="ghost" onClick={() => void markRead(n.id)} style={{ padding: "0.4rem 0.7rem", fontSize: "0.72rem" }}>
                    Read
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
