import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVault } from "../hooks/useVault";
import { forgetServer, renameServer, setActiveServer } from "../lib/vault";
import { unpairSelf } from "../lib/client";
import { hostOf, relativeTime } from "../lib/format";
import { toast } from "../lib/toast";

/**
 * Paired machines, and getting rid of them.
 *
 * "Forget" is deliberately two operations that can each fail independently:
 * tell the machine to revoke this device, then drop the local token. The local
 * drop happens either way — a phone you are giving away must lose its token
 * even if the machine is unreachable right now — but the failure is reported,
 * because a token that was never revoked server-side is still live until it
 * expires and the operator may want to revoke it from the dashboard.
 */
export function SettingsScreen() {
  const { servers, active } = useVault();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  async function forget(id: string): Promise<void> {
    const server = servers.find((s) => s.id === id);
    if (!server) return;
    if (!window.confirm(`Forget ${server.name}? You'll need a new pairing code to come back.`)) {
      return;
    }
    let revoked = true;
    try {
      await unpairSelf(server);
    } catch {
      revoked = false;
    }
    forgetServer(id);
    if (revoked) {
      toast.success(`Forgot ${server.name}`);
    } else {
      toast.error(
        `Removed locally, but ${server.name} couldn't be reached — revoke this device from the dashboard.`
      );
    }
    if (servers.length <= 1) navigate("/pair", { replace: true });
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <h1>Servers</h1>
      </header>

      {servers.length === 0 ? (
        <p className="muted center empty">No machines paired yet.</p>
      ) : (
        <ul className="list server-list">
          {servers.map((server) => (
            <li key={server.id} className={server.id === active?.id ? "server active" : "server"}>
              <div className="server-row">
                <div className="row-main">
                  {editing === server.id ? (
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      onBlur={() => {
                        renameServer(server.id, draftName);
                        setEditing(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setEditing(null);
                      }}
                      aria-label="Server name"
                    />
                  ) : (
                    <button
                      className="link-button row-title"
                      onClick={() => {
                        setEditing(server.id);
                        setDraftName(server.name);
                      }}
                    >
                      {server.name}
                    </button>
                  )}
                  <span className="muted tiny">{hostOf(server.url)}</span>
                  <span className="muted tiny">
                    {server.scope === "control" ? "Full control" : "Read only"} · paired{" "}
                    {relativeTime(server.pairedAt)}
                  </span>
                </div>
                {server.id !== active?.id && (
                  <button className="ghost small" onClick={() => setActiveServer(server.id)}>
                    Use
                  </button>
                )}
              </div>
              <button className="danger small block" onClick={() => void forget(server.id)}>
                Forget this machine
              </button>
            </li>
          ))}
        </ul>
      )}

      <button className="primary block" onClick={() => navigate("/pair")}>
        Pair another machine
      </button>

      <section className="about">
        <h2 className="section-title">About</h2>
        <p className="muted small">
          ServerHoster Companion talks straight to your own machines. There is no account and no middleman
          server — pairing writes a device token into this phone's storage and every request goes directly to
          the machine that issued it.
        </p>
        <p className="muted small">
          A paired phone can view status and logs and start, stop, restart or redeploy services. It can never
          read secrets, open a terminal, delete anything or pair another device. Revoke a phone any time from{" "}
          <strong>Settings → Companion</strong> on the dashboard.
        </p>
      </section>
    </main>
  );
}
