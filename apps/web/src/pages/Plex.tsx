import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Film,
  HardDrive,
  Loader2,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
  Upload,
  Users
} from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { toast } from "../lib/toast";
import { StatusBadge } from "../components/StatusBadge";
import { confirmDialog } from "../lib/confirm";

type PlexStatus = {
  installed: boolean;
  version: string | null;
  state: string;
  running: boolean;
  enabled: boolean;
  reachable: boolean;
  claimed: boolean;
  account: string | null;
  friendlyName: string | null;
  machineIdentifier: string | null;
  port: number;
  updatedAt: string;
};

type PlexLibrary = {
  key: string;
  title: string;
  type: string;
  agent: string | null;
  scanning: boolean;
  itemCount: number | null;
  locations: string[];
  updatedAt: string | null;
};

type PlexSession = {
  sessionKey: string;
  title: string;
  parentTitle: string | null;
  type: string;
  user: string | null;
  player: string | null;
  playerState: string | null;
  viewOffset: number | null;
  duration: number | null;
  transcoding: boolean;
  videoDecision: string | null;
};

type MediaFile = {
  name: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  partial: boolean;
};

type MediaLibrary = "movies" | "tv" | "music";

type UploadJob = {
  id: string;
  name: string;
  bytes: number;
  sent: number;
  status: "uploading" | "done" | "error";
  error?: string;
  abort: () => void;
};

const MEDIA_LIBRARIES: MediaLibrary[] = ["movies", "tv", "music"];

const POLL_MS = 10000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Uploads go through XHR rather than fetch: only XHR reports upload progress,
 * which matters when the file is several gigabytes. The body is the raw file,
 * so nothing is base64'd or buffered on the way out.
 */
function uploadMedia(
  file: File,
  library: MediaLibrary,
  folder: string,
  onProgress: (sent: number) => void
): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const params = new URLSearchParams({ library, filename: file.name });
  if (folder.trim()) params.set("folder", folder.trim());

  const promise = new Promise<void>((resolve, reject) => {
    xhr.open("POST", `${API_BASE_URL}/plex/upload?${params.toString()}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    const token = localStorage.getItem("survhub_token");
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* non-JSON error body */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(file);
  });

  return { promise, abort: () => xhr.abort() };
}

/** Plex serves its own web client on the same host and port as the API. */
function plexWebUrl(port: number): string {
  return `http://${window.location.hostname}:${port}/web`;
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function PlexPage() {
  const [status, setStatus] = useState<PlexStatus | null>(null);
  const [libraries, setLibraries] = useState<PlexLibrary[]>([]);
  const [sessions, setSessions] = useState<PlexSession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [mediaLibrary, setMediaLibrary] = useState<MediaLibrary>("movies");
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [folder, setFolder] = useState("");
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async (): Promise<PlexStatus | null> => {
    try {
      const res = await api<PlexStatus>("/plex/status", { silent: true });
      setStatus(res);
      setLoadError(false);
      return res;
    } catch {
      setLoadError(true);
      return null;
    }
  }, []);

  const loadDetail = useCallback(async (running: boolean): Promise<void> => {
    if (!running) {
      setLibraries([]);
      setSessions([]);
      return;
    }
    // Plex can be up but still starting its plugin host; treat either call
    // failing as "nothing to show yet" rather than surfacing an error toast.
    const [libs, sess] = await Promise.all([
      api<{ items: PlexLibrary[] }>("/plex/libraries", { silent: true }).catch(() => null),
      api<{ items: PlexSession[] }>("/plex/sessions", { silent: true }).catch(() => null)
    ]);
    if (libs) setLibraries(libs.items);
    if (sess) setSessions(sess.items);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await loadStatus();
    await loadDetail(Boolean(res?.running));
  }, [loadStatus, loadDetail]);

  useEffect(() => {
    void refresh();
    const intv = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(intv);
  }, [refresh]);

  async function power(action: "start" | "stop" | "restart"): Promise<void> {
    if (action !== "start") {
      const ok = await confirmDialog({
        title: `${action === "stop" ? "Stop" : "Restart"} Plex Media Server?`,
        message:
          action === "stop"
            ? "Active streams will be cut off and the server will go offline for all users."
            : "Active streams will be interrupted while the server restarts.",
        confirmLabel: action === "stop" ? "Stop Plex" : "Restart Plex",
        danger: true
      });
      if (!ok) return;
    }
    setBusy(action);
    try {
      const res = await api<PlexStatus>("/plex/power", {
        method: "POST",
        body: JSON.stringify({ action })
      });
      setStatus(res);
      toast.success(`Plex ${action === "stop" ? "stopped" : `${action}ed`}`);
      await loadDetail(res.running);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function toggleAutostart(): Promise<void> {
    if (!status) return;
    setBusy("autostart");
    try {
      const res = await api<PlexStatus>("/plex/autostart", {
        method: "POST",
        body: JSON.stringify({ enabled: !status.enabled })
      });
      setStatus(res);
      toast.success(res.enabled ? "Plex will start on boot" : "Plex autostart disabled");
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function scanLibrary(lib: PlexLibrary): Promise<void> {
    setBusy(`scan-${lib.key}`);
    try {
      await api(`/plex/libraries/${lib.key}/refresh`, { method: "POST" });
      toast.success(`Scanning "${lib.title}"`);
      // The scan flag flips asynchronously; re-read shortly after.
      setTimeout(() => void refresh(), 1500);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  const loadMedia = useCallback(async (library: MediaLibrary): Promise<void> => {
    try {
      const res = await api<{ items: MediaFile[] }>(`/plex/media?library=${library}`, {
        silent: true
      });
      setMediaFiles(res.items);
    } catch {
      setMediaFiles([]);
    }
  }, []);

  useEffect(() => {
    void loadMedia(mediaLibrary);
  }, [mediaLibrary, loadMedia]);

  function startUploads(files: File[]): void {
    if (files.length === 0) return;
    const targetLibrary = mediaLibrary;
    const targetFolder = folder;

    for (const file of files) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
      const { promise, abort } = uploadMedia(file, targetLibrary, targetFolder, (sent) => {
        setUploads((prev) => prev.map((j) => (j.id === id ? { ...j, sent } : j)));
      });

      setUploads((prev) => [
        ...prev,
        { id, name: file.name, bytes: file.size, sent: 0, status: "uploading", abort }
      ]);

      void promise
        .then(() => {
          setUploads((prev) =>
            prev.map((j) => (j.id === id ? { ...j, status: "done", sent: file.size } : j))
          );
          toast.success(`Uploaded ${file.name}`);
          void loadMedia(targetLibrary);
          void refresh();
          // Drop the finished row after a beat so the list doesn't grow forever.
          setTimeout(() => setUploads((prev) => prev.filter((j) => j.id !== id)), 6000);
        })
        .catch((error: Error) => {
          setUploads((prev) =>
            prev.map((j) => (j.id === id ? { ...j, status: "error", error: error.message } : j))
          );
          toast.error(`${file.name}: ${error.message}`);
        });
    }
  }

  async function deleteMedia(item: MediaFile): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${item.name}?`,
      message: `This permanently removes the file from /srv/media/${mediaLibrary}.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    try {
      await api(
        `/plex/media?library=${mediaLibrary}&path=${encodeURIComponent(item.relativePath)}`,
        { method: "DELETE" }
      );
      toast.success(`Deleted ${item.name}`);
      await loadMedia(mediaLibrary);
    } catch {
      /* toasted */
    }
  }

  async function loadLog(): Promise<void> {
    setBusy("log");
    try {
      const res = await api<{ log: string }>("/plex/logs?lines=300");
      setLog(res.log);
      setLogOpen(true);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  if (loadError && !status) {
    return (
      <div className="plex-page">
        <header className="page-header">
          <h2>Plex</h2>
        </header>
        <section className="card">
          <div className="empty-state is-error">
            <AlertTriangle size={28} className="text-danger" />
            <p>Could not reach the Plex controller.</p>
            <button className="ghost small" onClick={() => void refresh()}>
              <RotateCw size={14} /> Retry
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (status && !status.installed) {
    return (
      <div className="plex-page">
        <header className="page-header">
          <h2>Plex</h2>
        </header>
        <section className="card">
          <div className="empty-state">
            <Film size={28} />
            <p>Plex Media Server is not installed on this host.</p>
            <p className="muted small">
              Install the <code>plexmediaserver</code> package, then reload this tab.
            </p>
          </div>
        </section>
      </div>
    );
  }

  const running = Boolean(status?.running);
  const badge = !status ? "none" : status.running ? "running" : status.state === "failed" ? "crashed" : "stopped";

  return (
    <div className="plex-page">
      <header className="page-header">
        <h2>Plex Media Server</h2>
        <div className="row" style={{ gap: "0.6rem" }}>
          <StatusBadge status={badge} label={status?.state ?? "unknown"} />
          {running && (
            <a
              className="ghost xsmall plex-open"
              href={plexWebUrl(status?.port ?? 32400)}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={13} /> Open Plex
            </a>
          )}
          <button className="ghost xsmall" onClick={() => void refresh()} title="Refresh">
            <RotateCw size={13} />
          </button>
        </div>
      </header>

      <section className="card">
        <div className="section-title">
          <h3>Server</h3>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button
              className="primary small"
              disabled={running || busy !== null}
              onClick={() => void power("start")}
            >
              {busy === "start" ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Start
            </button>
            <button
              className="ghost small"
              disabled={!running || busy !== null}
              onClick={() => void power("restart")}
            >
              {busy === "restart" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}{" "}
              Restart
            </button>
            <button
              className="ghost small danger"
              disabled={!running || busy !== null}
              onClick={() => void power("stop")}
            >
              {busy === "stop" ? <Loader2 size={14} className="spin" /> : <Square size={14} />} Stop
            </button>
          </div>
        </div>

        <div className="plex-kv">
          <div>
            <span className="muted tiny uppercase">Version</span>
            <span>{status?.version ?? "—"}</span>
          </div>
          <div>
            <span className="muted tiny uppercase">Plex Account</span>
            <span>
              {status?.claimed ? (
                status.account ?? "claimed"
              ) : (
                <span className="text-warning">unclaimed</span>
              )}
            </span>
          </div>
          <div>
            <span className="muted tiny uppercase">API</span>
            <span>
              {status?.reachable ? (
                `127.0.0.1:${status.port}`
              ) : (
                <span className="muted">not responding</span>
              )}
            </span>
          </div>
          <div>
            <span className="muted tiny uppercase">Start On Boot</span>
            <span className="row" style={{ gap: "0.5rem" }}>
              {status?.enabled ? "Enabled" : "Disabled"}
              <button
                className="ghost tiny"
                disabled={busy !== null}
                onClick={() => void toggleAutostart()}
              >
                {busy === "autostart" ? <Loader2 size={12} className="spin" /> : <Power size={12} />}
                {status?.enabled ? "Disable" : "Enable"}
              </button>
            </span>
          </div>
        </div>

        {status && !status.claimed && (
          <p className="muted small plex-note">
            This server isn&apos;t linked to a Plex account yet. Claim it from the Plex web app to
            enable remote access and sharing.
          </p>
        )}
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <Users size={15} /> Now Playing
          </h3>
          <span className="chip">{sessions.length} active</span>
        </div>
        {!running ? (
          <div className="muted italic small">Server is stopped.</div>
        ) : sessions.length === 0 ? (
          <div className="muted italic small">Nothing is streaming right now.</div>
        ) : (
          <div className="plex-list">
            {sessions.map((s) => (
              <div key={s.sessionKey} className="plex-row">
                <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                  <span className="plex-title">
                    {s.parentTitle ? `${s.parentTitle} — ${s.title}` : s.title}
                  </span>
                  <span className="muted tiny">
                    {[s.user, s.player, s.playerState].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <span className="muted tiny">
                  {formatDuration(s.viewOffset)} / {formatDuration(s.duration)}
                </span>
                <span className={`chip xsmall ${s.transcoding ? "warn" : ""}`}>
                  {s.transcoding ? `transcode${s.videoDecision ? ` (${s.videoDecision})` : ""}` : "direct"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <HardDrive size={15} /> Libraries
          </h3>
          <span className="chip">{libraries.length}</span>
        </div>
        {!running ? (
          <div className="muted italic small">Server is stopped.</div>
        ) : libraries.length === 0 ? (
          <div className="muted italic small">
            No libraries yet. Add one from the Plex web app — media lives in <code>/srv/media</code>.
          </div>
        ) : (
          <div className="plex-list">
            {libraries.map((lib) => (
              <div key={lib.key} className="plex-row">
                <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                  <span className="plex-title">
                    {lib.title}
                    <span className="chip xsmall uppercase" style={{ marginLeft: "0.5rem" }}>
                      {lib.type}
                    </span>
                    {lib.scanning && (
                      <span className="chip xsmall warn" style={{ marginLeft: "0.35rem" }}>
                        scanning
                      </span>
                    )}
                  </span>
                  <span className="muted tiny plex-paths">{lib.locations.join(", ") || "—"}</span>
                </div>
                <span className="muted tiny">
                  {lib.itemCount == null ? "—" : `${lib.itemCount} items`}
                </span>
                <button
                  className="ghost tiny"
                  disabled={busy !== null}
                  onClick={() => void scanLibrary(lib)}
                  title="Scan library files"
                >
                  {busy === `scan-${lib.key}` ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  Scan
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title">
          <h3>
            <Upload size={15} /> Media Files
          </h3>
          <div className="row" style={{ gap: "0.5rem" }}>
            <select
              value={mediaLibrary}
              onChange={(e) => setMediaLibrary(e.target.value as MediaLibrary)}
              style={{ width: "110px" }}
            >
              {MEDIA_LIBRARIES.map((lib) => (
                <option key={lib} value={lib}>
                  {lib}
                </option>
              ))}
            </select>
            <button className="ghost tiny" onClick={() => void loadMedia(mediaLibrary)}>
              <RotateCw size={12} />
            </button>
          </div>
        </div>

        <div className="row plex-upload-opts">
          <input
            placeholder="Optional subfolder, e.g. Dune (2021)"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>

        <div
          className={`plex-drop ${dragging ? "is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            startUploads(Array.from(e.dataTransfer.files));
          }}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
          }}
        >
          <Upload size={22} />
          <span>
            Drop files here, or <u>browse</u>
          </span>
          <span className="muted tiny">
            Uploads to <code>/srv/media/{mediaLibrary}</code>
            {folder.trim() ? `/${folder.trim()}` : ""} and triggers a scan
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              startUploads(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>

        {uploads.length > 0 && (
          <div className="plex-list">
            {uploads.map((job) => {
              const pct = job.bytes > 0 ? Math.round((job.sent / job.bytes) * 100) : 0;
              return (
                <div key={job.id} className="plex-row">
                  <div className="fcol" style={{ gap: "0.3rem", minWidth: 0, flex: 1 }}>
                    <span className="plex-title">{job.name}</span>
                    <div className="plex-bar">
                      <div
                        className={`plex-bar-fill ${job.status}`}
                        style={{ width: `${job.status === "done" ? 100 : pct}%` }}
                      />
                    </div>
                    {job.status === "error" && (
                      <span className="tiny text-danger">{job.error}</span>
                    )}
                  </div>
                  <span className="muted tiny">
                    {job.status === "done"
                      ? formatBytes(job.bytes)
                      : `${formatBytes(job.sent)} / ${formatBytes(job.bytes)}`}
                  </span>
                  {job.status === "uploading" ? (
                    <button className="ghost tiny" onClick={() => job.abort()}>
                      Cancel
                    </button>
                  ) : (
                    <span className="chip xsmall">{job.status}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {mediaFiles.length === 0 ? (
          <div className="muted italic small" style={{ marginTop: "0.75rem" }}>
            No files in <code>/srv/media/{mediaLibrary}</code> yet.
          </div>
        ) : (
          <div className="plex-list">
            {mediaFiles.map((item) => (
              <div key={item.relativePath} className="plex-row">
                <div className="fcol" style={{ gap: "0.15rem", minWidth: 0, flex: 1 }}>
                  <span className="plex-title">
                    {item.name}
                    {item.partial && (
                      <span className="chip xsmall warn" style={{ marginLeft: "0.5rem" }}>
                        incomplete
                      </span>
                    )}
                  </span>
                  <span className="muted tiny plex-paths">{item.relativePath}</span>
                </div>
                <span className="muted tiny">{formatBytes(item.bytes)}</span>
                <button
                  className="ghost tiny"
                  onClick={() => void deleteMedia(item)}
                  title="Delete file"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title">
          <h3>Diagnostics</h3>
          <div className="row" style={{ gap: "0.5rem" }}>
            {log && (
              <button className="ghost tiny" onClick={() => setLogOpen(!logOpen)}>
                {logOpen ? "Hide" : "Show"}
              </button>
            )}
            <button className="ghost small" disabled={busy !== null} onClick={() => void loadLog()}>
              {busy === "log" ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />} Load
              Log
            </button>
          </div>
        </div>
        {log && logOpen ? (
          <pre className="plex-log">{log}</pre>
        ) : (
          <div className="muted italic small">
            Tail the Plex Media Server log to diagnose startup or scanning problems.
          </div>
        )}
      </section>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .plex-page .plex-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; margin-top: 0.75rem; }
        .plex-page .plex-kv > div { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
        .plex-page .plex-kv span:last-child { font-size: 0.85rem; font-weight: 500; }
        .plex-page .uppercase { text-transform: uppercase; letter-spacing: 0.04em; }
        .plex-page .plex-note { margin-top: 1rem; padding: 0.6rem 0.8rem; border-radius: 8px; background: var(--warning-soft); color: var(--warning); }
        .plex-page .plex-list { display: flex; flex-direction: column; margin-top: 0.5rem; }
        .plex-page .plex-row { display: flex; align-items: center; gap: 1rem; padding: 0.7rem 0; border-bottom: 1px solid var(--border-subtle); }
        .plex-page .plex-row:last-child { border-bottom: none; }
        .plex-page .plex-title { font-size: 0.88rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .plex-page .plex-paths { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono, monospace); }
        .plex-page .chip.warn { background: var(--warning-soft); color: var(--warning); border-color: var(--warning); }
        .plex-page .xsmall { font-size: 0.65rem; padding: 0.1rem 0.4rem; }
        .plex-page .plex-open { display: inline-flex; align-items: center; gap: 0.35rem; text-decoration: none; }
        .plex-page .plex-log { margin-top: 0.75rem; max-height: 420px; overflow: auto; font-size: 0.72rem; line-height: 1.5; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
        .plex-page .section-title h3 { display: inline-flex; align-items: center; gap: 0.45rem; }
        .plex-page .plex-upload-opts { margin-top: 0.75rem; gap: 0.5rem; }
        .plex-page .plex-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.4rem; margin-top: 0.6rem; padding: 1.5rem; border: 1px dashed var(--border-strong); border-radius: 10px; cursor: pointer; transition: var(--transition); text-align: center; }
        .plex-page .plex-drop:hover, .plex-page .plex-drop:focus-visible { border-color: var(--accent, var(--success)); background: var(--bg-glass); }
        .plex-page .plex-drop.is-over { border-color: var(--success); background: var(--success-soft); }
        .plex-page .plex-bar { height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden; }
        .plex-page .plex-bar-fill { height: 100%; background: var(--accent, var(--success)); transition: width 0.2s ease; }
        .plex-page .plex-bar-fill.done { background: var(--success); }
        .plex-page .plex-bar-fill.error { background: var(--danger); }
        .plex-page .spin { animation: plex-spin 1s linear infinite; }
        @keyframes plex-spin { to { transform: rotate(360deg); } }
      `
        }}
      />
    </div>
  );
}
