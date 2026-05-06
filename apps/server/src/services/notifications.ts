import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { broadcast, nowIso, serializeError } from "../lib/core.js";
import { getSetting } from "./settings.js";

export type NotificationKind = "deployment" | "service_crash" | "ssl" | "disk" | "system" | "tunnel";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export type Notification = {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  service_id: string | null;
  read: number;
  created_at: string;
};

export function createNotification(
  ctx: AppContext,
  input: {
    kind: NotificationKind;
    severity: NotificationSeverity;
    title: string;
    body?: string;
    serviceId?: string;
  }
): Notification {
  const row: Notification = {
    id: nanoid(),
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    body: input.body ?? null,
    service_id: input.serviceId ?? null,
    read: 0,
    created_at: nowIso()
  };
  ctx.db
    .prepare(
      `INSERT INTO notifications (id, kind, severity, title, body, service_id, read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.kind, row.severity, row.title, row.body, row.service_id, row.read, row.created_at);
  broadcast(ctx, { type: "notification", notification: row });
  void forwardToExternalWebhook(ctx, row);
  return row;
}

export function listNotifications(
  ctx: AppContext,
  opts: { unreadOnly?: boolean; limit?: number } = {}
): Notification[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = opts.unreadOnly
    ? ctx.db.prepare("SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC LIMIT ?").all(limit)
    : ctx.db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows as Notification[];
}

export function markRead(ctx: AppContext, id: string): void {
  ctx.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
}

export function markAllRead(ctx: AppContext): number {
  const res = ctx.db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
  return res.changes ?? 0;
}

export function unreadCount(ctx: AppContext): number {
  const row = ctx.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE read = 0").get() as {
    count: number;
  };
  return row.count;
}

/**
 * Forward a notification to an external Discord/Slack webhook if one is
 * configured in settings. Best-effort: failures are logged and do not affect
 * the in-app notification record.
 */
async function forwardToExternalWebhook(ctx: AppContext, notification: Notification): Promise<void> {
  const url = getSetting(ctx, "notification_webhook_url");
  if (!url) return;
  const kind = getSetting(ctx, "notification_webhook_kind") ?? "discord";
  const icon =
    notification.severity === "error"
      ? "🔥"
      : notification.severity === "warning"
        ? "⚠️"
        : notification.severity === "success"
          ? "✅"
          : "ℹ️";
  const content = `${icon} **${notification.title}**${notification.body ? `\n${notification.body}` : ""}`;
  try {
    const body = kind === "slack" ? JSON.stringify({ text: content }) : JSON.stringify({ content }); // discord
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
  } catch (error) {
    ctx.app.log.warn(`notification webhook forward failed: ${serializeError(error)}`);
  }
}
