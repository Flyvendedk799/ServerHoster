import type { AppContext } from "../types.js";
import { provisionCertificate } from "./ssl.js";
import { drainCleanupQueue } from "./cleanupQueue.js";
import { createNotification } from "./notifications.js";

/**
 * Daily renewal pass for Let's Encrypt certificates. Renews any cert within 30
 * days of expiry, drains the Cloudflare cleanup queue (DNS / ingress retries
 * deferred from S3), and circuit-breaks domains that have failed too many times
 * in a row to protect Let's Encrypt rate limits.
 */

type FailureRecord = { count: number; lastAt: number };
const FAIL_BUDGET = 3;
const FAIL_WINDOW_MS = 6 * 60 * 60 * 1000;
const failures = new Map<string, FailureRecord>();

function isCircuitBroken(domain: string): boolean {
  const f = failures.get(domain);
  if (!f) return false;
  if (Date.now() - f.lastAt > FAIL_WINDOW_MS) {
    failures.delete(domain);
    return false;
  }
  return f.count >= FAIL_BUDGET;
}

function recordFailure(domain: string): void {
  const f = failures.get(domain);
  if (!f || Date.now() - f.lastAt > FAIL_WINDOW_MS) {
    failures.set(domain, { count: 1, lastAt: Date.now() });
  } else {
    failures.set(domain, { count: f.count + 1, lastAt: Date.now() });
  }
}

function clearFailure(domain: string): void {
  failures.delete(domain);
}

type CertRow = { domain: string; expires_at: number };
type ServiceRow = { id: string; domain: string; ssl_status: string | null };

/**
 * Run a single renewal pass. Safe to call repeatedly; each call is cheap when
 * nothing is due. Returns counts so callers can log a summary.
 */
export async function renewExpiringCerts(
  ctx: AppContext
): Promise<{ renewed: number; failed: number; cleanup: number }> {
  // Drain pending Cloudflare cleanups first so subsequent renewals see a clean
  // ingress / DNS state.
  let cleanup = 0;
  try {
    const drain = await drainCleanupQueue(ctx);
    cleanup = drain.done;
  } catch {
    /* ignore — best-effort */
  }

  const cutoff = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const due = ctx.db
    .prepare("SELECT domain, expires_at FROM certificates WHERE expires_at < ? ORDER BY expires_at ASC")
    .all(cutoff) as CertRow[];

  let renewed = 0;
  let failed = 0;
  for (const cert of due) {
    if (isCircuitBroken(cert.domain)) continue;
    // We need a serviceId to feed provisionCertificate; pick the first service
    // bound to this domain. If none, the cert is orphaned — drop it.
    const svc = ctx.db
      .prepare("SELECT id, domain, ssl_status FROM services WHERE domain = ? LIMIT 1")
      .get(cert.domain) as ServiceRow | undefined;
    if (!svc) {
      ctx.db.prepare("DELETE FROM certificates WHERE domain = ?").run(cert.domain);
      continue;
    }
    // Don't renew Cloudflare-tunnel domains; CF supplies the edge cert.
    if (svc.ssl_status === "cloudflare") continue;
    try {
      await provisionCertificate(ctx, svc.id, cert.domain);
      clearFailure(cert.domain);
      renewed++;
    } catch (error) {
      failed++;
      recordFailure(cert.domain);
      const f = failures.get(cert.domain);
      if (f && f.count >= FAIL_BUDGET) {
        createNotification(ctx, {
          kind: "ssl",
          severity: "error",
          title: `Cert renewal circuit broken for ${cert.domain}`,
          body: `${f.count} consecutive failures within ${Math.round(FAIL_WINDOW_MS / 3_600_000)}h. Manual investigation required.`,
          serviceId: svc.id
        });
      }
      void error;
    }
  }

  return { renewed, failed, cleanup };
}

let renewalTimer: NodeJS.Timeout | null = null;
let bootKickTimer: NodeJS.Timeout | null = null;

/**
 * Schedule daily renewal + a 60-second post-boot kick. Returns a stop fn
 * suitable for ctx.shutdownTasks.
 */
export function startSslRenewalLoop(ctx: AppContext): () => void {
  bootKickTimer = setTimeout(() => {
    void renewExpiringCerts(ctx).catch(() => undefined);
  }, 60_000);
  renewalTimer = setInterval(
    () => {
      void renewExpiringCerts(ctx).catch(() => undefined);
    },
    24 * 60 * 60 * 1000
  );
  return () => {
    if (bootKickTimer) clearTimeout(bootKickTimer);
    if (renewalTimer) clearInterval(renewalTimer);
    bootKickTimer = null;
    renewalTimer = null;
  };
}
