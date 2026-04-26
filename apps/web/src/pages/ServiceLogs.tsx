import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";

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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!serviceId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [rows, svc] = await Promise.all([
          api<LogRow[]>(`/services/${serviceId}/logs`),
          api<Service>(`/services`).then((all: any) => all.find((s: any) => s.id === serviceId) ?? { id: serviceId, name: serviceId })
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
    });
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

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [filtered, autoScroll]);

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
      case "error": return "#fca5a5";
      case "warn": return "#fcd34d";
      case "info": return "#a5f3fc";
      default: return "#cbd5e1";
    }
  }

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>
          Logs — {service?.name ?? serviceId} <Link to="/services" className="link" style={{ fontSize: "0.85rem", marginLeft: "1rem" }}>← back</Link>
        </h2>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}>
            <option value="all">All levels</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <input
            placeholder="Search (grep)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: "200px" }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.9rem" }}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
          <button onClick={downloadLogs}>Download .txt</button>
          <button
            onClick={() => setLogs([])}
            style={{ background: "#334155" }}
            title="Clear buffer (does not delete from server)"
          >
            Clear view
          </button>
        </div>

        <div
          style={{
            background: "#020617",
            border: "1px solid #1e293b",
            borderRadius: "6px",
            padding: "0.75rem",
            fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
            fontSize: "0.82rem",
            height: "62vh",
            overflowY: "auto",
            lineHeight: 1.4
          }}
        >
          {loading && <p style={{ color: "#64748b" }}>Loading logs…</p>}
          {!loading && filtered.length === 0 && (
            <p style={{ color: "#64748b" }}>No log entries match the current filter.</p>
          )}
          {filtered.map((log, i) => (
            <div key={log.id ?? `${log.timestamp}-${i}`} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              <span style={{ color: "#475569" }}>
                {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ""}
              </span>{" "}
              <span style={{ color: levelColor(log.level), fontWeight: 600 }}>
                [{log.level ?? "info"}]
              </span>{" "}
              <span style={{ color: "#e2e8f0" }}>{log.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
          Showing {filtered.length} of {logs.length} buffered lines. Server keeps the most recent 5000.
        </div>
      </div>
    </section>
  );
}
