import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Bot, Download, Eraser, Search, Terminal } from "lucide-react";
import { api } from "../lib/api";
import { connectLogs, type LiveStatus } from "../lib/ws";
import { toast } from "../lib/toast";
import { openServiceTerminal } from "../components/TerminalDock";

type LogRow = {
  id?: string;
  service_id?: string;
  level?: string;
  message: string;
  timestamp?: string;
};

type Service = { id: string; name: string };

type LevelFilter = "all" | "info" | "warn" | "error";

export function ServiceLogsPage() {
  const { id: serviceId } = useParams<{ id: string }>();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [service, setService] = useState<Service | null>(null);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [newSinceScroll, setNewSinceScroll] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  // Mirror of autoScroll for the WS callback, whose closure is created once.
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  useEffect(() => {
    if (!serviceId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [rows, svc] = await Promise.all([
          api<LogRow[]>(`/services/${serviceId}/logs`),
          api<Service>(`/services`).then(
            (all: any) => all.find((s: any) => s.id === serviceId) ?? { id: serviceId, name: serviceId }
          )
        ]);
        if (cancelled) return;
        // API returns newest-first; display oldest-first so auto-scroll lands on newest.
        setLogs(rows.slice().reverse());
        setService(svc);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string; serviceId?: string; service_id?: string };
      if (typed.type !== "log") return;
      if ((typed.serviceId ?? typed.service_id) !== serviceId) return;
      setLogs((prev) => [...prev, payload as LogRow].slice(-5000));
      // When the user has scrolled up (follow disabled), tally arrivals so the
      // jump pill can advertise how many lines are waiting below.
      if (!autoScrollRef.current) setNewSinceScroll((n) => n + 1);
    });
    ws.onStatus(setLiveStatus);
    return () => {
      cancelled = true;
      ws.close();
    };
  }, [serviceId]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return logs.filter((log) => {
      if (levelFilter !== "all" && (log.level ?? "info") !== levelFilter) return false;
      if (q && !log.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, levelFilter, search]);

  // Live per-level counts for the filter dropdown (counted over the full buffer,
  // independent of the active level filter so each option shows its own total).
  const levelCounts = useMemo(() => {
    const counts = { all: logs.length, info: 0, warn: 0, error: 0 };
    for (const log of logs) {
      const lvl = (log.level ?? "info") as Exclude<LevelFilter, "all">;
      if (lvl in counts) counts[lvl] += 1;
    }
    return counts;
  }, [logs]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [filtered, autoScroll]);

  function handleViewerScroll(): void {
    const el = viewerRef.current;
    if (!el) return;
    // Treat "within a line height of the bottom" as following.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom) {
      if (!autoScroll) setAutoScroll(true);
      if (newSinceScroll !== 0) setNewSinceScroll(0);
    } else if (autoScroll) {
      // User scrolled up: stop following and start counting new arrivals.
      setAutoScroll(false);
      setNewSinceScroll(0);
    }
  }

  function jumpToLive(): void {
    setAutoScroll(true);
    setNewSinceScroll(0);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  function downloadLogs(): void {
    try {
      const body = filtered
        .map((log) => `[${log.timestamp ?? ""}] [${log.level ?? "info"}] ${log.message}`)
        .join("\n");
      const blob = new Blob([body], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${service?.name ?? serviceId}-logs-${new Date().toISOString().slice(0, 19)}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${filtered.length} log lines`);
    } catch (err) {
      toast.error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function levelColor(level: string | undefined): string {
    switch (level) {
      case "error":
        return "#fca5a5";
      case "warn":
        return "#fcd34d";
      case "info":
        return "#a5f3fc";
      default:
        return "#cbd5e1";
    }
  }

  return (
    <section className="service-logs-page">
      <div className="page-header">
        <div className="title-group">
          <h2>Terminal Pro</h2>
          <p className="muted">
            <span
              className={`status-dot ${liveStatus === "open" ? "running" : liveStatus === "connecting" ? "pending" : "stopped"}`}
              title={`Log stream ${liveStatus}`}
            />{" "}
            {liveStatus === "open"
              ? "Streaming live logs"
              : liveStatus === "connecting"
                ? "Connecting to log stream…"
                : "Log stream disconnected"}{" "}
            for {service?.name ?? serviceId}
          </p>
        </div>
        <Link to="/services" className="button ghost small">
          Back to Services
        </Link>
        {service && (
          <>
            <button className="ghost small" onClick={() => openServiceTerminal(service, "shell")}>
              <Terminal size={15} /> Console
            </button>
            <button className="ghost small" onClick={() => openServiceTerminal(service, "agents")}>
              <Bot size={15} /> Agents
            </button>
          </>
        )}
      </div>

      <div className="card terminal-card">
        <div className="terminal-toolbar">
          <Terminal size={16} className="text-accent" />
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}>
            <option value="all">All levels ({levelCounts.all})</option>
            <option value="info">info ({levelCounts.info})</option>
            <option value="warn">warn ({levelCounts.warn})</option>
            <option value="error">error ({levelCounts.error})</option>
          </select>
          <div className="terminal-search">
            <Search size={15} />
            <input placeholder="Search logs..." value={search} onChange={(e) => setSearch(e.target.value)} />
            {search.trim() && (
              <span className="muted small">
                {filtered.length} {filtered.length === 1 ? "match" : "matches"}
              </span>
            )}
          </div>
          <label className="toggle-inline">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
          <button onClick={downloadLogs}>
            <Download size={15} /> Export
          </button>
          <button onClick={() => setLogs([])} title="Clear buffer (does not delete from server)">
            <Eraser size={15} /> Clear
          </button>
        </div>

        <div className="logs-viewer-wrap">
          <div className="logs-viewer terminal-pro" ref={viewerRef} onScroll={handleViewerScroll}>
            {loading &&
              Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={`skeleton-${i}`}
                  className="log-skeleton-row"
                  style={{ width: `${90 - (i % 4) * 14}%`, animationDelay: `${i * 0.09}s` }}
                />
              ))}
            {!loading && filtered.length === 0 && (
              <p className="muted">No log entries match the current filter.</p>
            )}
            {!loading &&
              filtered.map((log, i) => (
                <div key={log.id ?? `${log.timestamp}-${i}`} className={`log-line level-${log.level ?? "info"}`}>
                  <span className="log-time">
                    {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ""}
                  </span>{" "}
                  <span className="log-level" style={{ color: levelColor(log.level) }}>
                    [{log.level ?? "info"}]
                  </span>{" "}
                  <span className="log-msg">{log.message}</span>
                </div>
              ))}
            <div ref={bottomRef} />
          </div>
          {!autoScroll && (
            <button className="log-jump-pill" onClick={jumpToLive}>
              {newSinceScroll > 0
                ? `${newSinceScroll} new ↓`
                : "Jump to live ↓"}
            </button>
          )}
        </div>

        <div className="muted small">
          Showing {filtered.length} of {logs.length} buffered lines. Server keeps the most recent 5000.
        </div>
      </div>
    </section>
  );
}
