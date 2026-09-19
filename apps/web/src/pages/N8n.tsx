import { useEffect, useRef, useState } from "react";
import { Power, RotateCw, Square, ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";

type N8nStatus = {
  running: boolean;
  state: string;
  port: number;
};

export function N8nPage() {
  const [status, setStatus] = useState<N8nStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string>("");
  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchStatus = async () => {
    try {
      const res = await api<N8nStatus>("/n8n/status");
      setStatus(res);
    } catch (e: any) {
      toast.error(e.message || "Failed to fetch n8n status");
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await api<{ log: string }>("/n8n/logs");
      setLogs(res.log);
    } catch (e: any) {
      // ignoring log fetch failures silently
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    const interval = setInterval(() => {
      fetchStatus();
      fetchLogs();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const setPower = async (action: "start" | "stop" | "restart") => {
    setLoading(true);
    try {
      const res = await api<N8nStatus>("/n8n/power", { 
        method: "POST", 
        body: JSON.stringify({ action }) 
      });
      setStatus(res);
      toast.success(`n8n ${action}ed`);
    } catch (e: any) {
      toast.error(e.message || `Failed to ${action} n8n`);
    } finally {
      setLoading(false);
      fetchLogs();
    }
  };

  return (
    <div className="pg-content">
      <header className="pg-header">
        <div>
          <h1 className="pg-title">n8n</h1>
          <p className="pg-desc">Workflow Automation with AI Gateway Integration</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            className="btn btn-primary flex items-center gap-2"
            disabled={loading || status?.running}
            onClick={() => setPower("start")}
          >
            <Power className="w-4 h-4" /> Start
          </button>
          <button
            className="btn flex items-center gap-2"
            disabled={loading || !status?.running}
            onClick={() => setPower("restart")}
          >
            <RotateCw className="w-4 h-4" /> Restart
          </button>
          <button
            className="btn btn-danger flex items-center gap-2"
            disabled={loading || !status?.running}
            onClick={() => setPower("stop")}
          >
            <Square className="w-4 h-4" /> Stop
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Status</h2>
          </div>
          <div className="card-body">
            {loading && !status ? (
              <div className="text-gray-400">Loading...</div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-400">State:</span>
                  <StatusBadge status={status?.running ? "running" : "stopped"} />
                  <span className="text-sm text-gray-500 capitalize">{status?.state || "unknown"}</span>
                </div>
                {status?.running && (
                  <a 
                    href={`http://localhost:${status.port}`} 
                    target="_blank" 
                    rel="noreferrer"
                    className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" /> Open n8n UI
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">AI Gateway Proxy</h2>
          </div>
          <div className="card-body space-y-4">
            <p className="text-sm text-gray-300 leading-relaxed">
              This instance of n8n is configured to use the host's <code>ai-auth</code> CLI credentials. 
              Inside n8n, use the "Advanced AI" OpenAI nodes.
            </p>
            <div className="bg-gray-800/50 p-4 rounded-lg border border-gray-700/50">
              <p className="text-sm text-gray-400">
                <strong>No configuration is necessary.</strong> The LocalSURV gateway injects your credentials automatically.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="card mt-6">
        <div className="card-header">
          <h2 className="card-title">Logs</h2>
        </div>
        <div className="bg-[#0f1115] border-t border-gray-800 p-4 font-mono text-[11px] leading-snug text-gray-300 h-96 overflow-y-auto whitespace-pre-wrap">
          {logs || "No logs available."}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
