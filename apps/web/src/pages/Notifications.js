import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
const SEVERITY_COLOR = {
  success: "var(--success)",
  info: "var(--info)",
  warning: "var(--warning)",
  error: "var(--danger)"
};
export function NotificationsPage() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKind, setWebhookKind] = useState("discord");
  async function load() {
    try {
      const res = await api("/notifications", { silent: true });
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      /* silent */
    }
  }
  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload === "object" && payload && payload.type === "notification") void load();
    });
    return () => ws.close();
  }, []);
  async function markRead(id) {
    try {
      await api(`/notifications/${id}/read`, { method: "POST" });
      await load();
    } catch {
      /* toasted */
    }
  }
  async function readAll() {
    try {
      await api("/notifications/read-all", { method: "POST" });
      toast.success("All notifications marked read");
      await load();
    } catch {
      /* toasted */
    }
  }
  async function saveWebhook() {
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
  return _jsxs("div", {
    className: "notifications-page",
    children: [
      _jsxs("header", {
        className: "page-header",
        children: [
          _jsx("h2", { children: "Event Stream" }),
          _jsxs("div", {
            className: "row",
            children: [
              _jsxs("span", {
                className: `chip ${unread > 0 ? "active-alert" : ""}`,
                children: [unread, " Unread Alerts"]
              }),
              unread > 0 &&
                _jsx("button", { className: "ghost xsmall", onClick: readAll, children: "Mark All Read" })
            ]
          })
        ]
      }),
      _jsxs("section", {
        className: "card featured-form",
        style: { marginBottom: "3rem" },
        children: [
          _jsx("div", {
            className: "section-title",
            children: _jsx("h3", { children: "Outgoing Webhooks" })
          }),
          _jsx("p", {
            className: "muted small",
            style: { marginBottom: "1rem" },
            children: "Stream critical alerts to external team channels."
          }),
          _jsxs("div", {
            className: "row",
            style: { gap: "1rem" },
            children: [
              _jsxs("select", {
                value: webhookKind,
                onChange: (e) => setWebhookKind(e.target.value),
                style: { width: "120px" },
                children: [
                  _jsx("option", { value: "discord", children: "Discord" }),
                  _jsx("option", { value: "slack", children: "Slack" })
                ]
              }),
              _jsx("input", {
                placeholder: "https://...",
                value: webhookUrl,
                onChange: (e) => setWebhookUrl(e.target.value),
                style: { flex: 1 }
              }),
              _jsx("button", { className: "primary", onClick: saveWebhook, children: "Connect Hub" })
            ]
          })
        ]
      }),
      _jsx("section", {
        className: "card list-container",
        style: { padding: 0 },
        children:
          items.length === 0
            ? _jsx("div", {
                className: "muted italic text-center",
                style: { padding: "4rem" },
                children: "Your inbox is clear. No recent system alerts."
              })
            : _jsx("div", {
                className: "notification-list",
                children: items.map((n) =>
                  _jsxs(
                    "div",
                    {
                      className: `notification-item row ${n.read ? "read" : "unread"}`,
                      children: [
                        _jsx("div", {
                          className: "severity-bar",
                          style: { background: SEVERITY_COLOR[n.severity] }
                        }),
                        _jsxs("div", {
                          className: "content",
                          style: { flex: 1 },
                          children: [
                            _jsxs("div", {
                              className: "row between",
                              children: [
                                _jsx("h4", { className: "font-semibold", children: n.title }),
                                _jsx("span", {
                                  className: "tiny muted",
                                  children: new Date(n.created_at).toLocaleTimeString()
                                })
                              ]
                            }),
                            n.body && _jsx("p", { className: "muted small", children: n.body }),
                            _jsxs("div", {
                              className: "row tiny muted",
                              style: { marginTop: "0.5rem", gap: "0.5rem" },
                              children: [
                                _jsx("span", { className: "chip xsmall uppercase", children: n.kind }),
                                _jsx("span", { children: "\u2022" }),
                                _jsx("span", { children: new Date(n.created_at).toLocaleDateString() })
                              ]
                            })
                          ]
                        }),
                        !n.read &&
                          _jsx("button", {
                            className: "ghost tiny",
                            onClick: () => markRead(n.id),
                            children: "Mark Read"
                          })
                      ]
                    },
                    n.id
                  )
                )
              })
      }),
      _jsx("style", {
        dangerouslySetInnerHTML: {
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
        }
      })
    ]
  });
}
