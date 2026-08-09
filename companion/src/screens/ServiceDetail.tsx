import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import { useSummary } from "../hooks/useSummary";
import { useVault } from "../hooks/useVault";
import { fetchServiceLogs, serviceAction } from "../lib/client";
import type { ServiceAction } from "../lib/client";
import { connectLive } from "../lib/live";
import type { LiveStatus } from "../lib/live";
import { describeError } from "../lib/pairing";
import { formatClock, relativeTime } from "../lib/format";
import { toast } from "../lib/toast";

type LogLine = { id: string; level: string; message: string; timestamp: string };

const MAX_LINES = 400;

const ACTIONS: Array<{ id: ServiceAction; label: string; tone: string; confirm?: string }> = [
  { id: "start", label: "Start", tone: "primary" },
  { id: "restart", label: "Restart", tone: "ghost", confirm: "Restart this service?" },
  { id: "stop", label: "Stop", tone: "danger", confirm: "Stop this service?" },
  { id: "redeploy", label: "Redeploy", tone: "ghost", confirm: "Pull the latest commit and redeploy?" }
];

/**
 * One service: what it is doing, and the four buttons that change it.
 *
 * Logs come from the same WebSocket the desktop uses, seeded with the last page
 * over HTTP so the view isn't empty until something happens — a service that is
 * quietly broken produces no new lines, which is exactly when you look at it.
 */
export function ServiceDetailScreen() {
  const { serviceId } = useParams<{ serviceId: string }>();
  const { active } = useVault();
  const navigate = useNavigate();
  const { data, refresh } = useSummary(active);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [pending, setPending] = useState<ServiceAction | null>(null);
  const [liveStatusOverride, setLiveStatusOverride] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLDivElement | null>(null);

  const service = useMemo(() => data?.services.find((s) => s.id === serviceId) ?? null, [data, serviceId]);
  const status = liveStatusOverride ?? service?.status ?? "unknown";
  const canControl = active?.scope === "control";

  const appendLine = useCallback((line: LogLine) => {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  // Seed from history, then follow the socket.
  useEffect(() => {
    if (!active || !serviceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const history = await fetchServiceLogs(active, serviceId);
        if (cancelled) return;
        // The endpoint returns newest-first; the view reads oldest-first.
        setLines(
          history
            .slice(0, MAX_LINES)
            .reverse()
            .map((row) => ({
              id: row.id,
              level: row.level,
              message: row.message,
              timestamp: row.timestamp
            }))
        );
      } catch {
        /* the live stream may still deliver; don't shout about history */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, serviceId]);

  useEffect(() => {
    if (!active || !serviceId) return;
    const connection = connectLive(active, {
      onStatus: setLiveStatus,
      onEvent: (event) => {
        if (event.type === "log" && event.serviceId === serviceId) {
          appendLine({
            id: `${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
            level: String(event.level ?? "info"),
            message: String(event.message ?? ""),
            timestamp: String(event.timestamp ?? new Date().toISOString())
          });
        } else if (event.type === "service_status" && event.serviceId === serviceId) {
          // Believe the socket over the poll: it is seconds ahead.
          setLiveStatusOverride(String(event.status));
        }
      }
    });
    return () => connection.close();
  }, [active, serviceId, appendLine]);

  // Autoscroll, but stop fighting the user the moment they scroll up to read.
  useEffect(() => {
    if (!follow) return;
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, follow]);

  async function run(action: (typeof ACTIONS)[number]): Promise<void> {
    if (!active || !serviceId || pending) return;
    if (action.confirm && !window.confirm(action.confirm)) return;
    setPending(action.id);
    try {
      await serviceAction(active, serviceId, action.id);
      toast.success(`${action.label} requested`);
      setLiveStatusOverride(null);
      refresh();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setPending(null);
    }
  }

  if (!service && data) {
    return (
      <main className="screen">
        <button className="ghost" onClick={() => navigate("/services")}>
          ← Services
        </button>
        <p className="muted center empty">That service is gone.</p>
      </main>
    );
  }

  return (
    <main className="screen detail-screen">
      <header className="detail-header">
        <button className="ghost back" onClick={() => navigate(-1)} aria-label="Back">
          ←
        </button>
        <div className="detail-title">
          <h1>{service?.name ?? "Service"}</h1>
          <p className="muted tiny">
            {service?.projectName ?? "no project"}
            {service?.port ? ` · port ${service.port}` : ""}
          </p>
        </div>
        <StatusPill status={status} small />
      </header>

      {!canControl && (
        <p className="notice notice-info">
          This phone is paired read-only. Pair again with control access to use these buttons.
        </p>
      )}

      <div className="action-grid">
        {ACTIONS.map((action) => (
          <button
            key={action.id}
            className={action.tone}
            disabled={!canControl || pending !== null}
            onClick={() => void run(action)}
          >
            {pending === action.id ? "…" : action.label}
          </button>
        ))}
      </div>

      <section className="log-section">
        <div className="log-toolbar">
          <h2 className="section-title">Logs</h2>
          <span className={`live-dot live-${liveStatus}`} aria-label={`Stream ${liveStatus}`} />
          <label className="follow-toggle">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
            Follow
          </label>
        </div>
        <div
          className="log-view"
          ref={logRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            if (atBottom !== follow) setFollow(atBottom);
          }}
        >
          {lines.length === 0 ? (
            <p className="muted tiny">No log output yet.</p>
          ) : (
            lines.map((line) => (
              <div key={line.id} className={`log-line log-${line.level}`}>
                <span className="log-time">{formatClock(line.timestamp)}</span>
                <span className="log-message">{line.message}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {data && (
        <section>
          <h2 className="section-title">Deploys</h2>
          <ul className="list">
            {data.deployments
              .filter((deployment) => deployment.serviceId === serviceId)
              .slice(0, 5)
              .map((deployment) => (
                <li key={deployment.id} className="static-row">
                  <div className="row-main">
                    <span className="row-title">
                      {deployment.commitHash ? deployment.commitHash.slice(0, 7) : "local"}
                    </span>
                    <span className="muted tiny">{relativeTime(deployment.createdAt)}</span>
                  </div>
                  <StatusPill status={deployment.status} small />
                </li>
              ))}
          </ul>
        </section>
      )}
    </main>
  );
}
