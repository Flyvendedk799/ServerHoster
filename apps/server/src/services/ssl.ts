import crypto from "node:crypto";
import * as acme from "acme-client";
import { nanoid } from "nanoid";
import type { AppContext } from "../types.js";
import { insertLog, nowIso, updateServiceStatus } from "../lib/core.js";
import { getSetting } from "./settings.js";
import { createAcmeDnsRecord, deleteAcmeDnsRecord } from "./cloudflare.js";
import { createNotification } from "./notifications.js";

// Global map to store active HTTP-01 challenges for the proxy to pick up
export const activeChallenges = new Map<string, string>();

const SELF_TEST_TOKEN = "self-test";

/**
 * Preflight reachability check: publish a sentinel value under the ACME
 * challenge path and confirm the public domain serves it back. This avoids
 * burning Let's Encrypt rate-limit budget on domains whose DNS or port 80
 * isn't actually reachable.
 */
export async function verifyAcmeChallengeReachability(domain: string): Promise<void> {
  const sentinel = `survhub-reachability-${nanoid(12)}`;
  activeChallenges.set(SELF_TEST_TOKEN, sentinel);
  try {
    const url = `http://${domain}/.well-known/acme-challenge/${SELF_TEST_TOKEN}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    let body = "";
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      body = (await res.text()).trim();
    } finally {
      clearTimeout(timer);
    }
    if (body !== sentinel) {
      throw new Error(`Self-test mismatch for ${domain}: expected sentinel, got "${body.slice(0, 64)}"`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Domain ${domain} is not reachable on port 80 for ACME HTTP-01 challenges (${msg}). ` +
        `Make sure DNS points at this server and port 80 is open before retrying SSL.`
    );
  } finally {
    activeChallenges.delete(SELF_TEST_TOKEN);
  }
}

export async function provisionCertificate(ctx: AppContext, serviceId: string, domain: string) {
  const mode = (getSetting(ctx, "ssl_mode") as "http-01" | "dns-01" | null) ?? "http-01";
  insertLog(
    ctx,
    serviceId,
    "info",
    `SSL: Starting Let's Encrypt production provisioning for ${domain} via ${mode}...`
  );
  ctx.db.prepare("UPDATE services SET ssl_status = ? WHERE id = ?").run("provisioning", serviceId);

  try {
    const client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt.production,
      accountKey: await acme.crypto.createPrivateKey()
    });

    const [key, csr] = await acme.crypto.createCsr({ commonName: domain });

    if (mode === "http-01") {
      insertLog(ctx, serviceId, "info", `SSL: Running HTTP-01 reachability preflight for ${domain}...`);
      await verifyAcmeChallengeReachability(domain);
      insertLog(ctx, serviceId, "info", `SSL: Preflight OK, ${domain} is reachable on port 80.`);

      const order = await client.createOrder({ identifiers: [{ type: "dns", value: domain }] });
      const authorizations = await client.getAuthorizations(order);

      for (const authz of authorizations) {
        const challenge = authz.challenges.find((c) => c.type === "http-01");
        if (!challenge) throw new Error("No http-01 challenge available");
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
        activeChallenges.set(challenge.token, keyAuthorization);
        try {
          await client.verifyChallenge(authz, challenge);
          await client.completeChallenge(challenge);
          await client.waitForValidStatus(authz);
        } finally {
          activeChallenges.delete(challenge.token);
        }
      }

      const fullchain = await client.finalizeOrder(order, csr);
      persistCertificate(ctx, serviceId, domain, fullchain.toString(), key.toString());
    } else {
      // DNS-01 via Cloudflare. Uses acme-client's auto() helper which handles
      // all authorizations via our challengeCreateFn / challengeRemoveFn.
      const dnsRecords = new Map<string, string>(); // token -> record id
      const fullchain = await client.auto({
        csr,
        email: getSetting(ctx, "acme_email") ?? `survhub-admin@${domain}`,
        termsOfServiceAgreed: true,
        challengePriority: ["dns-01"],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
          if (challenge.type !== "dns-01") throw new Error("Only dns-01 supported in this mode");
          const recordName = `_acme-challenge.${domain}`;
          const recordId = await createAcmeDnsRecord(ctx, recordName, keyAuthorization);
          dnsRecords.set(challenge.token, recordId);
          insertLog(
            ctx,
            serviceId,
            "info",
            `SSL: Published DNS-01 TXT record ${recordName} (id ${recordId})`
          );
          // Give the record time to propagate before acme-client hits the authoritative resolver.
          await new Promise((r) => setTimeout(r, 15000));
        },
        challengeRemoveFn: async (_authz, challenge) => {
          const id = dnsRecords.get(challenge.token);
          if (id) {
            await deleteAcmeDnsRecord(ctx, id);
            dnsRecords.delete(challenge.token);
          }
        }
      });
      persistCertificate(ctx, serviceId, domain, fullchain.toString(), key.toString());
    }

    ctx.db.prepare("UPDATE services SET ssl_status = ? WHERE id = ?").run("secure", serviceId);
    insertLog(ctx, serviceId, "info", `SSL: Certificate successfully provisioned for ${domain}!`);
    createNotification(ctx, {
      kind: "ssl",
      severity: "success",
      title: `SSL certificate issued for ${domain}`,
      serviceId
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    insertLog(ctx, serviceId, "error", `SSL Provisioning failed for ${domain}: ${msg}`);
    ctx.db.prepare("UPDATE services SET ssl_status = ? WHERE id = ?").run("error", serviceId);
    createNotification(ctx, {
      kind: "ssl",
      severity: "error",
      title: `SSL provisioning failed for ${domain}`,
      body: msg.slice(0, 400),
      serviceId
    });
    throw error;
  }
}

function persistCertificate(
  ctx: AppContext,
  serviceId: string,
  domain: string,
  fullchain: string,
  privkey: string
): void {
  ctx.db
    .prepare(
      `
    INSERT OR REPLACE INTO certificates (id, domain, fullchain, privkey, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(nanoid(), domain, fullchain, privkey, Date.now() + 90 * 24 * 60 * 60 * 1000, nowIso());
  void serviceId;
}
