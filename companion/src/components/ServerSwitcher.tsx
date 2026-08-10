import { useNavigate } from "react-router-dom";
import { useVault } from "../hooks/useVault";
import { setActiveServer } from "../lib/vault";
import { hostOf } from "../lib/format";

/**
 * Switch between paired machines. Rendered as a native `<select>` when there is
 * more than one: the OS picker is thumb-friendly, keyboard accessible and free,
 * and a custom dropdown would be none of those on a phone.
 */
export function ServerSwitcher() {
  const { servers, active } = useVault();
  const navigate = useNavigate();

  if (!active) return null;
  // With a single machine there is nothing to switch to, so the control
  // collapses to a plain heading — and carries the screen's <h1> with it, since
  // the machine's name is what the screen is actually about.
  if (servers.length === 1) {
    return (
      <div className="server-switcher single">
        <h1 className="server-name">{active.name}</h1>
        <span className="muted tiny">{hostOf(active.url)}</span>
      </div>
    );
  }

  return (
    <div className="server-switcher">
      <label className="sr-only" htmlFor="server-select">
        Active server
      </label>
      <select
        id="server-select"
        value={active.id}
        onChange={(event) => {
          if (event.target.value === "__pair__") {
            navigate("/pair");
            return;
          }
          setActiveServer(event.target.value);
        }}
      >
        {servers.map((server) => (
          <option key={server.id} value={server.id}>
            {server.name} — {hostOf(server.url)}
          </option>
        ))}
        <option value="__pair__">Pair another machine…</option>
      </select>
    </div>
  );
}
