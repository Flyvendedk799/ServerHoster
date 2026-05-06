/**
 * Per-service inbound-request inspector. Stores the last N requests per
 * service in memory (no persistence, since this can be high-volume) so the
 * dashboard can render an ngrok-style traffic feed.
 *
 * Capacity per service is intentionally modest (200 entries) to keep the
 * memory footprint of a long-running server bounded even with bursty
 * traffic.
 */

const MAX_PER_SERVICE = 200;

export type InspectedRequest = {
  requestId: string;
  serviceId: string;
  timestamp: string;
  method: string;
  path: string;
  status: number | null;
  latencyMs: number | null;
  remoteAddress: string | null;
  userAgent: string | null;
  host: string;
};

const BUFFERS = new Map<string, InspectedRequest[]>();

export function recordInboundRequest(req: InspectedRequest): void {
  let buf = BUFFERS.get(req.serviceId);
  if (!buf) {
    buf = [];
    BUFFERS.set(req.serviceId, buf);
  }
  buf.push(req);
  if (buf.length > MAX_PER_SERVICE) buf.splice(0, buf.length - MAX_PER_SERVICE);
}

export function listRequests(serviceId: string, limit = 100): InspectedRequest[] {
  const buf = BUFFERS.get(serviceId);
  if (!buf) return [];
  // Newest-first
  return buf.slice(-Math.max(1, Math.min(limit, MAX_PER_SERVICE))).reverse();
}

export function clearRequests(serviceId: string): void {
  BUFFERS.delete(serviceId);
}

/** Test-only: reset all buffers between integration tests. */
export function _resetAllRequestBuffers(): void {
  BUFFERS.clear();
}
