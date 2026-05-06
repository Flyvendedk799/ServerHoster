import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Download, Eraser, Search, Terminal } from "lucide-react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";
import { toast } from "../lib/toast";
export function ServiceLogsPage() {
  const { id: serviceId } = useParams();
  const [logs, setLogs] = useState([]);
  const [service, setService] = useState(null);
  const [levelFilter, setLevelFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef(null);
  useEffect(() => {
    if (!serviceId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [rows, svc] = await Promise.all([
          api(`/services/${serviceId}/logs`),
          api(`/services`).then(
            (all) => all.find((s) => s.id === serviceId) ?? { id: serviceId, name: serviceId }
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
      const typed = payload;
      if (typed.type !== "log") return;
      if ((typed.serviceId ?? typed.service_id) !== serviceId) return;
      setLogs((prev) => [...prev, payload].slice(-5000));
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
  function downloadLogs() {
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
  function levelColor(level) {
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
  return _jsxs("section", {
    className: "service-logs-page",
    children: [
      _jsxs("div", {
        className: "page-header",
        children: [
          _jsxs("div", {
            className: "title-group",
            children: [
              _jsx("h2", { children: "Terminal Pro" }),
              _jsxs("p", { className: "muted", children: ["Live logs for ", service?.name ?? serviceId] })
            ]
          }),
          _jsx(Link, { to: "/services", className: "button ghost small", children: "Back to Services" })
        ]
      }),
      _jsxs("div", {
        className: "card terminal-card",
        children: [
          _jsxs("div", {
            className: "terminal-toolbar",
            children: [
              _jsx(Terminal, { size: 16, className: "text-accent" }),
              _jsxs("select", {
                value: levelFilter,
                onChange: (e) => setLevelFilter(e.target.value),
                children: [
                  _jsx("option", { value: "all", children: "All levels" }),
                  _jsx("option", { value: "info", children: "info" }),
                  _jsx("option", { value: "warn", children: "warn" }),
                  _jsx("option", { value: "error", children: "error" })
                ]
              }),
              _jsxs("div", {
                className: "terminal-search",
                children: [
                  _jsx(Search, { size: 15 }),
                  _jsx("input", {
                    placeholder: "Search logs...",
                    value: search,
                    onChange: (e) => setSearch(e.target.value)
                  })
                ]
              }),
              _jsxs("label", {
                className: "toggle-inline",
                children: [
                  _jsx("input", {
                    type: "checkbox",
                    checked: autoScroll,
                    onChange: (e) => setAutoScroll(e.target.checked)
                  }),
                  "Auto-scroll"
                ]
              }),
              _jsxs("button", { onClick: downloadLogs, children: [_jsx(Download, { size: 15 }), " Export"] }),
              _jsxs("button", {
                onClick: () => setLogs([]),
                title: "Clear buffer (does not delete from server)",
                children: [_jsx(Eraser, { size: 15 }), " Clear"]
              })
            ]
          }),
          _jsxs("div", {
            className: "logs-viewer terminal-pro",
            children: [
              loading && _jsx("p", { className: "muted", children: "Loading logs..." }),
              !loading &&
                filtered.length === 0 &&
                _jsx("p", { className: "muted", children: "No log entries match the current filter." }),
              filtered.map((log, i) =>
                _jsxs(
                  "div",
                  {
                    className: `log-line level-${log.level ?? "info"}`,
                    children: [
                      _jsx("span", {
                        className: "log-time",
                        children: log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ""
                      }),
                      " ",
                      _jsxs("span", {
                        className: "log-level",
                        style: { color: levelColor(log.level) },
                        children: ["[", log.level ?? "info", "]"]
                      }),
                      " ",
                      _jsx("span", { className: "log-msg", children: log.message })
                    ]
                  },
                  log.id ?? `${log.timestamp}-${i}`
                )
              ),
              _jsx("div", { ref: bottomRef })
            ]
          }),
          _jsxs("div", {
            className: "muted small",
            children: [
              "Showing ",
              filtered.length,
              " of ",
              logs.length,
              " buffered lines. Server keeps the most recent 5000."
            ]
          })
        ]
      })
    ]
  });
}
