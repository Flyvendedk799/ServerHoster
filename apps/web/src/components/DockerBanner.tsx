import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type DockerHealth = { available: boolean; hasDockerServices: boolean; message?: string };

/**
 * A single, dismissible banner shown when the Docker daemon is unreachable AND
 * the user actually runs container services — so a stopped Colima/Docker Desktop
 * reads as one clear "start Docker" prompt instead of every container service
 * failing individually with a cryptic error.
 */
export function DockerBanner() {
  const [health, setHealth] = useState<DockerHealth | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    const check = async (): Promise<void> => {
      try {
        const res = await api<DockerHealth>("/health/docker", { silent: true });
        if (!active) return;
        setHealth(res);
        if (res.available) setDismissed(false); // re-arm so a later outage re-shows
      } catch {
        /* transient API/network issue — handled elsewhere */
      }
    };
    void check();
    const intv = setInterval(() => void check(), 20000);
    return () => {
      active = false;
      clearInterval(intv);
    };
  }, []);

  if (!health || health.available || !health.hasDockerServices || dismissed) return null;

  return (
    <div className="docker-banner" role="alert">
      <AlertTriangle size={16} className="docker-banner-icon" />
      <span className="docker-banner-msg">
        {health.message ?? "Docker daemon is offline — your container services can't start."}
      </span>
      <code
        className="docker-banner-cmd copyable"
        title="Copy"
        onClick={() => {
          void navigator.clipboard
            .writeText("colima restart")
            .then(() => toast.success("Copied"))
            .catch(() => toast.error("Clipboard failed"));
        }}
      >
        colima restart
      </code>
      <button className="docker-banner-close" onClick={() => setDismissed(true)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
