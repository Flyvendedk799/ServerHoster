import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectLogs } from "./ws";

export type ExposureMode = "none" | "quick-tunnel" | "named-tunnel";

export type Exposure = {
  service: {
    id: string;
    name: string;
    port: number | null;
    domain: string | null;
    status: string;
    tunnel_url: string | null;
    quick_tunnel_enabled: boolean;
    ssl_status: string | null;
    public_url: string | null;
  };
  mode: ExposureMode;
  quickTunnel: { running: boolean; pid: number | null; tunnelUrl: string | null };
  namedTunnel: {
    binary: string | null;
    version: string | null;
    tokenConfigured: boolean;
    state: string;
    tunnelId: string | null;
    [key: string]: unknown;
  };
  proxyRoute: { domain: string; target_port: number } | null;
  certificate: {
    issuer: string;
    issued_at: string | null;
    expires_at: string;
    days_remaining: number;
  } | null;
  capabilities: {
    hasCloudflaredBinary: boolean;
    hasCloudflareApiToken: boolean;
    hasCloudflareTunnelToken: boolean;
    hasCloudflareTunnelId: boolean;
    hasCloudflareZoneId: boolean;
  };
};

/**
 * Subscribes to /services/:id/exposure with a small in-memory cache and
 * automatic refetch on `tunnel_url` and `exposure_changed` WS events.
 */
export function useExposure(serviceId: string | null): {
  data: Exposure | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const [data, setData] = useState<Exposure | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchAt = useRef(0);

  async function refetch(): Promise<void> {
    if (!serviceId) return;
    setLoading(true);
    try {
      const res = await api<Exposure>(`/services/${serviceId}/exposure`, { silent: true });
      setData(res);
      setError(null);
      lastFetchAt.current = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!serviceId) {
      setData(null);
      return;
    }
    void refetch();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const evt = payload as { type?: string; serviceId?: string };
      if (evt.type !== "tunnel_url" && evt.type !== "exposure_changed") return;
      if (evt.serviceId && evt.serviceId !== serviceId) return;
      // Coalesce noisy bursts: at most one refetch per 750ms.
      const since = Date.now() - lastFetchAt.current;
      if (since < 750) return;
      void refetch();
    });
    return () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  return { data, loading, error, refetch };
}
