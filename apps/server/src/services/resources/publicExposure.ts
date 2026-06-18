import net from "node:net";
import type { AppContext } from "../../types.js";

/**
 * Browser-facing linked resources should follow the service when it goes
 * public. The first profile supported here is Supabase: the frontend can use
 * the service's own origin as VITE_SUPABASE_URL while Cloudflare path-routes
 * Supabase's public API prefixes to the local stack.
 *
 * This is intentionally profile-descriptor based so future resource profiles
 * can opt into public exposure without changing the service/domain model.
 */

export type PublicResourceIngressRoute = {
  domain: string;
  path: string;
  port: number;
  serviceId: string;
  resourceId: string;
  profile: string;
};

export type PublicResourceProxyTarget = {
  serviceId: string;
  resourceId: string;
  profile: string;
  targetPort: number;
};

type Descriptor = {
  profile: string;
  portKey: string;
  paths: string[];
};

const PUBLIC_RESOURCE_DESCRIPTORS: Descriptor[] = [
  {
    profile: "supabase",
    portKey: "api",
    paths: ["^/(auth|rest|functions|storage|realtime|graphql)/v1(/.*)?$"]
  }
];

type CandidateRow = {
  service_id: string;
  resource_id: string;
  domain: string;
  ssl_status: string | null;
  profile: string;
  ports_json: string;
  config_json: string;
};

type PublicResourceTarget = {
  serviceId: string;
  resourceId: string;
  domain: string;
  scheme: "http" | "https";
  profile: string;
  port: number;
};

function parseJson<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json || "null");
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (net.isIP(host)) return false;
  return host.includes(".");
}

function schemeForService(sslStatus: string | null): "http" | "https" {
  return sslStatus === "cloudflare" || sslStatus === "secure" ? "https" : "http";
}

function portForDescriptor(row: CandidateRow, descriptor: Descriptor): number | null {
  const ports = parseJson<Record<string, unknown>>(row.ports_json, {});
  const byName = ports[descriptor.portKey];
  if (typeof byName === "number" && Number.isInteger(byName) && byName > 0) return byName;

  const config = parseJson<Record<string, unknown>>(row.config_json, {});
  const apiUrl = typeof config.api_url === "string" ? config.api_url : null;
  if (descriptor.profile === "supabase" && apiUrl) {
    try {
      const url = new URL(apiUrl);
      const port = Number(url.port);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* ignore invalid stored URLs */
    }
  }
  return null;
}

function descriptorForProfile(profile: string): Descriptor | null {
  return PUBLIC_RESOURCE_DESCRIPTORS.find((d) => d.profile === profile) ?? null;
}

function selectedPublicResourceTargets(ctx: AppContext): PublicResourceTarget[] {
  const rows = ctx.db
    .prepare(
      `SELECT l.service_id, l.resource_id, pr.domain, s.ssl_status,
              mr.profile, mr.ports_json, mr.config_json
       FROM service_resource_links l
       JOIN managed_resources mr ON mr.id = l.resource_id
       JOIN proxy_routes pr ON pr.service_id = l.service_id
       JOIN services s ON s.id = l.service_id
       WHERE l.active = 1
         AND pr.domain IS NOT NULL
       ORDER BY pr.created_at, l.created_at, l.rowid`
    )
    .all() as CandidateRow[];

  const byServiceDomainProfile = new Map<string, PublicResourceTarget>();
  for (const row of rows) {
    if (!isPublicHostname(row.domain)) continue;
    const descriptor = descriptorForProfile(row.profile);
    if (!descriptor) continue;
    const port = portForDescriptor(row, descriptor);
    if (!port) continue;

    // Later resource links win, matching runtimeEnv.ts merge precedence.
    byServiceDomainProfile.set(`${row.service_id}:${row.domain}:${row.profile}`, {
      serviceId: row.service_id,
      resourceId: row.resource_id,
      domain: row.domain.toLowerCase(),
      scheme: schemeForService(row.ssl_status),
      profile: row.profile,
      port
    });
  }
  return Array.from(byServiceDomainProfile.values());
}

export function publicOriginForLinkedResource(
  ctx: AppContext,
  serviceId: string,
  resourceId: string,
  profile: string
): string | null {
  const target = selectedPublicResourceTargets(ctx).find(
    (t) => t.serviceId === serviceId && t.resourceId === resourceId && t.profile === profile
  );
  return target ? `${target.scheme}://${target.domain}` : null;
}

export function publicResourceIngressRoutes(ctx: AppContext): PublicResourceIngressRoute[] {
  const routes: PublicResourceIngressRoute[] = [];
  for (const target of selectedPublicResourceTargets(ctx)) {
    const descriptor = descriptorForProfile(target.profile);
    if (!descriptor) continue;
    for (const path of descriptor.paths) {
      routes.push({
        domain: target.domain,
        path,
        port: target.port,
        serviceId: target.serviceId,
        resourceId: target.resourceId,
        profile: target.profile
      });
    }
  }
  return routes;
}

export function publicResourceRouteForRequest(
  ctx: AppContext,
  host: string,
  path: string
): PublicResourceProxyTarget | null {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  if (!hostname) return null;
  for (const route of publicResourceIngressRoutes(ctx)) {
    if (route.domain !== hostname) continue;
    if (!new RegExp(route.path).test(path)) continue;
    return {
      serviceId: route.serviceId,
      resourceId: route.resourceId,
      profile: route.profile,
      targetPort: route.port
    };
  }
  return null;
}
