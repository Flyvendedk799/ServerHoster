import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { Check, Cloud, Loader2, X } from "lucide-react";
export function TransferDatabaseModal({ databaseId, databaseName, engine, onClose }) {
  const [externalUrl, setExternalUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [ping, setPing] = useState({ state: "idle" });
  const supported = engine === "postgres" || engine === "mysql";
  async function testConnection() {
    if (!externalUrl.trim()) {
      toast.error("Paste a DATABASE_URL to test.");
      return;
    }
    setPing({ state: "pinging" });
    try {
      const res = await api(`/databases/${databaseId}/transfer/test`, {
        method: "POST",
        body: JSON.stringify({ externalUrl: externalUrl.trim() }),
        silent: true
      });
      if (res.ok && res.serverVersion) setPing({ state: "ok", serverVersion: res.serverVersion });
      else setPing({ state: "fail", error: res.error ?? "Unknown error" });
    } catch (error) {
      setPing({ state: "fail", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const transferIdRef = useRef(null);
  const wsRef = useRef(null);
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [output]);
  // Drop any open WS subscription on unmount.
  useEffect(
    () => () => {
      wsRef.current?.close();
    },
    []
  );
  async function submit() {
    if (!externalUrl.trim()) {
      toast.error("Paste the destination DATABASE_URL.");
      return;
    }
    setBusy(true);
    setOutput("");
    // Subscribe before kicking off the transfer so we don't miss the first chunks.
    wsRef.current?.close();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const evt = payload;
      if (evt.type !== "db_transfer" || evt.transferId !== transferIdRef.current) return;
      if (evt.chunk) setOutput((prev) => (prev + evt.chunk).slice(-200_000));
      if (evt.status === "ok" || evt.status === "error") {
        if (transferIdRef.current) {
          try {
            ws.send(JSON.stringify({ type: "detach_transfer", transferId: transferIdRef.current }));
          } catch {
            /* socket may already be closing */
          }
        }
        if (evt.status === "ok") toast.success(`Transferred ${databaseName} to hosted target.`);
        else toast.error(`Transfer failed: ${evt.error ?? "unknown error"}`);
        setBusy(false);
        ws.close();
      }
    });
    wsRef.current = ws;
    try {
      const res = await api(`/databases/${databaseId}/transfer/stream`, {
        method: "POST",
        body: JSON.stringify({ externalUrl: externalUrl.trim() })
      });
      transferIdRef.current = res.transferId;
      // Subscribe scoped events for this transferId. The server has a 200ms
      // grace before emitting chunks, plenty of time for this to arrive.
      const sendAttach = () => {
        try {
          ws.send(JSON.stringify({ type: "attach_transfer", transferId: res.transferId }));
        } catch {
          /* will retry in onopen */
        }
      };
      if (ws.readyState === WebSocket.OPEN) sendAttach();
      else ws.addEventListener("open", sendAttach, { once: true });
    } catch {
      ws.close();
      setBusy(false);
    }
  }
  return _jsx("div", {
    className: "modal-overlay",
    onClick: onClose,
    children: _jsxs("div", {
      className: "modal-content",
      style: { maxWidth: "640px" },
      onClick: (e) => e.stopPropagation(),
      children: [
        _jsxs("header", {
          className: "modal-header",
          children: [
            _jsxs("div", {
              className: "row",
              children: [_jsx(Cloud, { size: 20 }), _jsx("h3", { children: "Transfer to hosted database" })]
            }),
            _jsxs("p", {
              className: "hint",
              children: [
                "Pipes ",
                _jsx("code", { children: databaseName }),
                " into the destination via an ephemeral",
                " ",
                _jsx("code", { children: engine === "mysql" ? "mysql:8" : "postgres:16" }),
                " client container. The destination must already exist and be empty (or accept upserts)."
              ]
            })
          ]
        }),
        _jsxs("div", {
          className: "modal-body",
          children: [
            !supported &&
              _jsxs("div", {
                className: "promote-warning",
                children: [
                  "Transfer is only supported for ",
                  _jsx("code", { children: "postgres" }),
                  " and ",
                  _jsx("code", { children: "mysql" }),
                  " engines today."
                ]
              }),
            _jsxs("div", {
              className: "form-group",
              children: [
                _jsx("label", { children: "Destination DATABASE_URL" }),
                _jsx("input", {
                  placeholder:
                    engine === "mysql"
                      ? "mysql://user:pass@hosted-host:3306/dbname"
                      : "postgres://user:pass@hosted-host:5432/dbname",
                  value: externalUrl,
                  onChange: (e) => {
                    setExternalUrl(e.target.value);
                    setPing({ state: "idle" });
                  },
                  disabled: !supported
                }),
                _jsxs("div", {
                  className: "row",
                  style: { gap: "0.5rem", marginTop: "0.4rem", alignItems: "center" },
                  children: [
                    _jsxs("button", {
                      type: "button",
                      className: "ghost xsmall",
                      onClick: () => void testConnection(),
                      disabled: !supported || ping.state === "pinging",
                      children: [
                        ping.state === "pinging"
                          ? _jsx(Loader2, { size: 12, className: "animate-spin" })
                          : _jsx(Check, { size: 12 }),
                        "Test connection"
                      ]
                    }),
                    ping.state === "ok" &&
                      _jsxs("span", {
                        className: "ping-good",
                        children: [
                          _jsx(Check, { size: 12 }),
                          " Reachable \u00B7 ",
                          ping.serverVersion.slice(0, 60)
                        ]
                      }),
                    ping.state === "fail" &&
                      _jsxs("span", {
                        className: "ping-bad",
                        children: [_jsx(X, { size: 12 }), " ", ping.error.slice(0, 200)]
                      })
                  ]
                }),
                _jsxs("p", {
                  className: "hint tiny",
                  children: [
                    "The URL is used in-process for the transfer and not stored. To repoint your service afterwards, use",
                    " ",
                    _jsx("em", { children: "Promote \u2192 Use existing DATABASE_URL" }),
                    "."
                  ]
                })
              ]
            }),
            (busy || output) &&
              _jsxs("div", {
                className: "form-group",
                children: [
                  _jsxs("label", {
                    children: [
                      "Transfer output ",
                      busy &&
                        _jsx(Loader2, {
                          size: 12,
                          className: "animate-spin",
                          style: { verticalAlign: "middle" }
                        })
                    ]
                  }),
                  _jsx("pre", {
                    ref: logRef,
                    className: "logs-viewer",
                    style: { height: "220px", whiteSpace: "pre-wrap" },
                    children: output || (busy ? "Starting transfer…" : "")
                  })
                ]
              })
          ]
        }),
        _jsxs("footer", {
          className: "modal-footer",
          children: [
            _jsx("button", { className: "ghost", onClick: onClose, disabled: busy, children: "Close" }),
            _jsx("button", {
              className: "primary",
              onClick: () => void submit(),
              disabled: busy || !supported,
              children: busy
                ? "Transferring..."
                : ping.state === "ok"
                  ? "Start transfer"
                  : "Start transfer (untested)"
            })
          ]
        }),
        _jsx("style", {
          dangerouslySetInnerHTML: {
            __html: `
          .ping-good { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--success, #10b981); font-size: 0.72rem; }
          .ping-bad { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--warn, #d97706); font-size: 0.72rem; max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
          .animate-spin { animation: spin 1s linear infinite; }
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `
          }
        })
      ]
    })
  });
}
