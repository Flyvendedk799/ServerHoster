import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { Check, Cloud, Loader2, X } from "lucide-react";

type Props = {
  databaseId: string;
  databaseName: string;
  engine: string;
  onClose: () => void;
};

type PingResult =
  | { state: "idle" }
  | { state: "pinging" }
  | { state: "ok"; serverVersion: string }
  | { state: "fail"; error: string };

export function TransferDatabaseModal({ databaseId, databaseName, engine, onClose }: Props) {
  const [externalUrl, setExternalUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [ping, setPing] = useState<PingResult>({ state: "idle" });

  const supported = engine === "postgres" || engine === "mysql";

  async function testConnection(): Promise<void> {
    if (!externalUrl.trim()) {
      toast.error("Paste a DATABASE_URL to test.");
      return;
    }
    setPing({ state: "pinging" });
    try {
      const res = await api<{ ok: boolean; serverVersion?: string; error?: string }>(
        `/databases/${databaseId}/transfer/test`,
        { method: "POST", body: JSON.stringify({ externalUrl: externalUrl.trim() }), silent: true }
      );
      if (res.ok && res.serverVersion) setPing({ state: "ok", serverVersion: res.serverVersion });
      else setPing({ state: "fail", error: res.error ?? "Unknown error" });
    } catch (error) {
      setPing({ state: "fail", error: error instanceof Error ? error.message : String(error) });
    }
  }

  const transferIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

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

  async function submit(): Promise<void> {
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
      const evt = payload as {
        type?: string;
        transferId?: string;
        chunk?: string;
        status?: string;
        error?: string;
      };
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
      const res = await api<{ transferId: string }>(`/databases/${databaseId}/transfer/stream`, {
        method: "POST",
        body: JSON.stringify({ externalUrl: externalUrl.trim() })
      });
      transferIdRef.current = res.transferId;
      // Subscribe scoped events for this transferId. The server has a 200ms
      // grace before emitting chunks, plenty of time for this to arrive.
      const sendAttach = (): void => {
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "640px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="row">
            <Cloud size={20} />
            <h3>Transfer to hosted database</h3>
          </div>
          <p className="hint">
            Pipes <code>{databaseName}</code> into the destination via an ephemeral{" "}
            <code>{engine === "mysql" ? "mysql:8" : "postgres:16"}</code> client container. The destination
            must already exist and be empty (or accept upserts).
          </p>
        </header>

        <div className="modal-body">
          {!supported && (
            <div className="promote-warning">
              Transfer is only supported for <code>postgres</code> and <code>mysql</code> engines today.
            </div>
          )}
          <div className="form-group">
            <label>Destination DATABASE_URL</label>
            <input
              placeholder={
                engine === "mysql"
                  ? "mysql://user:pass@hosted-host:3306/dbname"
                  : "postgres://user:pass@hosted-host:5432/dbname"
              }
              value={externalUrl}
              onChange={(e) => {
                setExternalUrl(e.target.value);
                setPing({ state: "idle" });
              }}
              disabled={!supported}
            />
            <div className="row" style={{ gap: "0.5rem", marginTop: "0.4rem", alignItems: "center" }}>
              <button
                type="button"
                className="ghost xsmall"
                onClick={() => void testConnection()}
                disabled={!supported || ping.state === "pinging"}
              >
                {ping.state === "pinging" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )}
                Test connection
              </button>
              {ping.state === "ok" && (
                <span className="ping-good">
                  <Check size={12} /> Reachable · {ping.serverVersion.slice(0, 60)}
                </span>
              )}
              {ping.state === "fail" && (
                <span className="ping-bad">
                  <X size={12} /> {ping.error.slice(0, 200)}
                </span>
              )}
            </div>
            <p className="hint tiny">
              The URL is used in-process for the transfer and not stored. To repoint your service afterwards,
              use <em>Promote &rarr; Use existing DATABASE_URL</em>.
            </p>
          </div>

          {(busy || output) && (
            <div className="form-group">
              <label>
                Transfer output{" "}
                {busy && <Loader2 size={12} className="animate-spin" style={{ verticalAlign: "middle" }} />}
              </label>
              <pre ref={logRef} className="logs-viewer" style={{ height: "220px", whiteSpace: "pre-wrap" }}>
                {output || (busy ? "Starting transfer…" : "")}
              </pre>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !supported}>
            {busy ? "Transferring..." : ping.state === "ok" ? "Start transfer" : "Start transfer (untested)"}
          </button>
        </footer>

        <style
          dangerouslySetInnerHTML={{
            __html: `
          .ping-good { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--success, #10b981); font-size: 0.72rem; }
          .ping-bad { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--warn, #d97706); font-size: 0.72rem; max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
          .animate-spin { animation: spin 1s linear infinite; }
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `
          }}
        />
      </div>
    </div>
  );
}
