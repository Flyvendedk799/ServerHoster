import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Smartphone, Trash2, Wifi, X } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { QrCode } from "./QrCode";

type EndpointCandidate = {
  url: string;
  kind: "configured" | "dashboard-origin" | "proxy-domain" | "lan" | "loopback";
  label: string;
  remote: boolean;
};

type Device = {
  id: string;
  name: string;
  platform: string | null;
  scope: "read" | "control";
  tokenPrefix: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
};

type Pairing = {
  id: string;
  code: string;
  scope: "read" | "control";
  serverUrl: string;
  serverName: string;
  expiresAt: number;
  payload: string;
  appLink: string | null;
};

type PairingStatus = {
  status: "pending" | "claimed" | "expired";
  device: Device | null;
};

const CUSTOM = "__custom__";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * "Pair a phone" — the desktop half of the companion handshake.
 *
 * The operator is already authenticated here, so this screen's only job is to
 * hand the phone two things it cannot guess: where this control plane lives,
 * and a one-shot code. Choosing the address is the part that actually needs a
 * human — the server can enumerate its own interfaces but cannot know which of
 * them survives a trip outside the house.
 */
export function CompanionPanel() {
  const [candidates, setCandidates] = useState<EndpointCandidate[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string>("");
  const [customUrl, setCustomUrl] = useState("");
  const [scope, setScope] = useState<"read" | "control">("control");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairedDevice, setPairedDevice] = useState<Device | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const data = await api<{ devices: Device[] }>("/companion/devices", { silent: true });
      setDevices(data.devices);
    } catch {
      /* surfaced by the panel staying empty */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ candidates: EndpointCandidate[] }>("/companion/endpoints", {
          silent: true
        });
        setCandidates(data.candidates);
        setSelectedUrl(data.candidates.find((c) => c.remote)?.url ?? data.candidates[0]?.url ?? "");
      } catch {
        /* leave the picker empty; the custom field still works */
      }
    })();
    void loadDevices();
  }, [loadDevices]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Countdown + expiry. The code dies after five minutes whether or not this
  // tab is watching, so the UI has to stop claiming it is still valid.
  useEffect(() => {
    if (!pairing) return;
    const tick = () => {
      const remaining = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) stopPolling();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing, stopPolling]);

  async function generate() {
    const serverUrl = selectedUrl === CUSTOM ? customUrl.trim() : selectedUrl;
    if (!serverUrl) {
      toast.error("Pick or enter the address your phone should connect to");
      return;
    }
    setBusy(true);
    setPairedDevice(null);
    try {
      const created = await api<Pairing>("/companion/pairings", {
        method: "POST",
        body: JSON.stringify({ scope, serverUrl })
      });
      setPairing(created);
      stopPolling();
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const status = await api<PairingStatus>(`/companion/pairings/${created.id}`, {
              silent: true,
              noAuthExpiry: true
            });
            if (status.status === "claimed") {
              stopPolling();
              setPairedDevice(status.device);
              setPairing(null);
              toast.success(`${status.device?.name ?? "Phone"} paired`);
              void loadDevices();
            } else if (status.status === "expired") {
              stopPolling();
            }
          } catch {
            /* transient — the next tick retries */
          }
        })();
      }, 2000);
    } catch {
      /* toasted by api() */
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!pairing) return;
    stopPolling();
    const id = pairing.id;
    setPairing(null);
    try {
      await api(`/companion/pairings/${id}`, { method: "DELETE", silent: true });
    } catch {
      /* the code expires on its own anyway */
    }
  }

  async function revoke(device: Device) {
    const ok = await confirmDialog({
      title: `Unpair ${device.name}?`,
      message: "That device loses access immediately and has to scan a new code to get back in.",
      confirmLabel: "Unpair",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/companion/devices/${device.id}`, { method: "DELETE" });
      toast.success(`${device.name} unpaired`);
      void loadDevices();
    } catch {
      /* toasted */
    }
  }

  const chosen = candidates.find((c) => c.url === selectedUrl);
  const localOnly = selectedUrl !== CUSTOM && chosen && !chosen.remote;

  return (
    <div className="form-stack companion-panel">
      <div className="card">
        <div className="row">
          <Smartphone className="text-accent" size={20} />
          <h3>Pair a phone</h3>
        </div>
        <p className="muted small" style={{ margin: "1rem 0" }}>
          Scan this code with the ServerHoster companion app to control this machine from your phone. The code
          is valid for five minutes and works once.
        </p>

        {!pairing && (
          <>
            <label className="small font-bold" htmlFor="companion-endpoint">
              Address the phone will connect to
            </label>
            <select
              id="companion-endpoint"
              value={selectedUrl}
              onChange={(e) => setSelectedUrl(e.target.value)}
              style={{ marginTop: "0.4rem" }}
            >
              {candidates.map((candidate) => (
                <option key={candidate.url} value={candidate.url}>
                  {candidate.url} — {candidate.label}
                </option>
              ))}
              <option value={CUSTOM}>Enter a different address…</option>
            </select>

            {selectedUrl === CUSTOM && (
              <input
                type="url"
                placeholder="https://hoster.example.com"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                style={{ marginTop: "0.5rem" }}
              />
            )}

            {localOnly && (
              <p className="small companion-warning" style={{ marginTop: "0.6rem" }}>
                <AlertTriangle size={14} />
                This address only resolves on your own network. To reach the machine from mobile data, expose
                the control plane first (Cloudflare Tunnel or a domain) and pair against that URL.
              </p>
            )}

            <label className="small font-bold" htmlFor="companion-scope" style={{ marginTop: "1rem" }}>
              What the phone may do
            </label>
            <select
              id="companion-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "read" | "control")}
              style={{ marginTop: "0.4rem" }}
            >
              <option value="control">Control — view everything, start/stop/restart/redeploy</option>
              <option value="read">Read only — view status and logs</option>
            </select>
            <p className="muted tiny" style={{ marginTop: "0.5rem" }}>
              A paired phone can never read secrets, open a terminal, delete a service or pair another device,
              whichever option you pick.
            </p>

            <div className="footer-actions">
              <button className="primary" onClick={generate} disabled={busy}>
                {busy ? <Loader2 size={16} className="spin" /> : <Smartphone size={16} />} Show pairing code
              </button>
            </div>
          </>
        )}

        {pairing && (
          <div className="companion-pairing">
            <div className="companion-qr">
              <QrCode value={pairing.appLink ?? pairing.payload} size={232} />
            </div>
            <div className="companion-pairing-side">
              <p className="muted small" style={{ marginBottom: "0.35rem" }}>
                Can't scan? Type this code into the app:
              </p>
              <div className="companion-code">{pairing.code}</div>
              <button
                className="ghost small font-bold"
                onClick={() =>
                  navigator.clipboard.writeText(pairing.code).then(() => toast.success("Pairing code copied"))
                }
              >
                <Copy size={14} /> Copy code
              </button>
              <dl className="companion-facts">
                <dt>Server</dt>
                <dd>{pairing.serverUrl}</dd>
                <dt>Access</dt>
                <dd>{pairing.scope === "control" ? "Control" : "Read only"}</dd>
                <dt>Expires in</dt>
                <dd className={secondsLeft <= 30 ? "text-warning" : undefined}>
                  {secondsLeft > 0
                    ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
                    : "expired"}
                </dd>
              </dl>
              <div className="row small muted" style={{ gap: "0.4rem" }}>
                {secondsLeft > 0 ? (
                  <>
                    <Loader2 size={14} className="spin" /> Waiting for the phone…
                  </>
                ) : (
                  <>
                    <AlertTriangle size={14} /> Code expired — generate a new one.
                  </>
                )}
              </div>
              <button className="ghost small" onClick={cancel} style={{ marginTop: "0.75rem" }}>
                <X size={14} /> Cancel
              </button>
            </div>
          </div>
        )}

        {pairedDevice && (
          <p className="small companion-success" style={{ marginTop: "1rem" }}>
            <Check size={14} /> {pairedDevice.name} is paired and can now reach this machine.
          </p>
        )}
      </div>

      <div className="card">
        <div className="row">
          <Wifi className="text-muted" size={20} />
          <h3>Paired devices</h3>
        </div>
        {devices.length === 0 ? (
          <p className="muted small" style={{ marginTop: "1rem" }}>
            No phones paired yet.
          </p>
        ) : (
          <ul className="companion-devices">
            {devices.map((device) => (
              <li key={device.id}>
                <div className="column" style={{ gap: "2px", alignItems: "flex-start" }}>
                  <span className="font-bold small">{device.name}</span>
                  <span className="tiny muted">
                    {device.platform ? `${device.platform} · ` : ""}
                    {device.scope === "control" ? "control" : "read only"} · last seen{" "}
                    {relativeTime(device.lastSeenAt)}
                    {device.lastSeenIp ? ` from ${device.lastSeenIp}` : ""}
                  </span>
                </div>
                <button className="ghost small danger ml-auto" onClick={() => revoke(device)}>
                  <Trash2 size={14} /> Unpair
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .companion-panel select, .companion-panel input[type="url"] { width: 100%; }
        .companion-panel .companion-pairing { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-top: 1rem; }
        .companion-panel .companion-qr { background: #fff; padding: 12px; border-radius: var(--radius-md); line-height: 0; box-shadow: var(--shadow-md); }
        .companion-panel .companion-pairing-side { flex: 1 1 240px; min-width: 240px; }
        .companion-panel .companion-code { font-family: var(--font-mono); font-size: 1.6rem; letter-spacing: 0.12em; color: var(--text-primary); margin-bottom: 0.5rem; }
        .companion-panel .companion-facts { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.75rem; margin: 1rem 0; font-size: 0.8rem; }
        .companion-panel .companion-facts dt { color: var(--text-muted); }
        .companion-panel .companion-facts dd { margin: 0; color: var(--text-secondary); overflow-wrap: anywhere; }
        .companion-panel .companion-warning { display: flex; gap: 0.45rem; align-items: flex-start; color: var(--warning); }
        .companion-panel .companion-success { display: flex; gap: 0.45rem; align-items: center; color: var(--success); }
        .companion-panel .companion-devices { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
        .companion-panel .companion-devices li { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
      `
        }}
      />
    </div>
  );
}
