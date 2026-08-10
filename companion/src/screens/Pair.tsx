import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { QrScanner } from "../components/QrScanner";
import { claimPairing, describeError, parsePairingInput, suggestDeviceName } from "../lib/pairing";
import { toast } from "../lib/toast";
import { useVault } from "../hooks/useVault";

type Mode = "scan" | "manual";

/**
 * Pairing: the one screen that exists before this phone knows anything.
 *
 * The happy path is two taps — open, point at the dashboard's QR — but every
 * step of that can fail on a real phone (camera denied, code half-read, the URL
 * in the QR unreachable from mobile data), so each failure falls back to a
 * form rather than a dead end. A scan that carries no server URL, or one whose
 * URL doesn't resolve, drops the user into the manual form with the code
 * already filled in.
 */
export function PairScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { servers } = useVault();
  const deepLink = useMemo(() => ({ url: params.get("s") ?? "", code: params.get("c") ?? "" }), [params]);

  const [mode, setMode] = useState<Mode>(deepLink.code ? "manual" : "scan");
  const [serverUrl, setServerUrl] = useState(deepLink.url);
  const [code, setCode] = useState(deepLink.code);
  const [deviceName, setDeviceName] = useState(suggestDeviceName());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A deep link arrives fully formed — claim it without making the user tap
  // "Connect" on a form they never asked to see.
  useEffect(() => {
    if (deepLink.url && deepLink.code) {
      void submit(deepLink.url, deepLink.code);
    }
    // Intentionally keyed on the link only: re-running on every keystroke would
    // re-claim a code the user is in the middle of correcting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink.url, deepLink.code]);

  async function submit(url: string, pairingCode: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const server = await claimPairing({ serverUrl: url, code: pairingCode, deviceName });
      toast.success(`Paired with ${server.name}`);
      navigate("/", { replace: true });
    } catch (err) {
      setProblem(describeError(err));
      setMode("manual");
    } finally {
      setBusy(false);
    }
  }

  function handleScan(text: string): void {
    const parsed = parsePairingInput(text);
    if (!parsed) {
      setProblem("That QR code isn't a ServerHoster pairing code.");
      return;
    }
    setCode(parsed.code);
    if (parsed.serverUrl) {
      void submit(parsed.serverUrl, parsed.code);
    } else {
      // A bare code carries no address, so we have to ask for one.
      setMode("manual");
      setProblem("Scanned the code. Now enter the address of the machine it belongs to.");
    }
  }

  return (
    <main className="screen pair-screen">
      <header className="pair-header">
        <h1>Pair with your machine</h1>
        <p className="muted">
          On your computer open ServerHoster → <strong>Settings → Companion</strong>, then scan the code it
          shows.
        </p>
      </header>

      <div className="segmented" role="tablist" aria-label="Pairing method">
        <button
          role="tab"
          aria-selected={mode === "scan"}
          className={mode === "scan" ? "active" : ""}
          onClick={() => setMode("scan")}
        >
          Scan QR
        </button>
        <button
          role="tab"
          aria-selected={mode === "manual"}
          className={mode === "manual" ? "active" : ""}
          onClick={() => setMode("manual")}
        >
          Enter code
        </button>
      </div>

      {problem && (
        <p className="notice notice-warn" role="alert">
          {problem}
        </p>
      )}

      {mode === "scan" ? (
        <>
          <QrScanner onResult={handleScan} onUnavailable={() => setMode("manual")} />
          <p className="muted small center">Point the camera at the code on your dashboard.</p>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(serverUrl, code);
          }}
        >
          <label htmlFor="pair-url">Server address</label>
          <input
            id="pair-url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://hoster.example.com"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            required
          />
          <p className="hint">
            The address shown on the pairing screen. To use it away from home this has to be reachable from
            the internet — a Cloudflare Tunnel hostname or your own domain.
          </p>

          <label htmlFor="pair-code">Pairing code</label>
          <input
            id="pair-code"
            className="code-input"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />

          <label htmlFor="pair-name">This device's name</label>
          <input
            id="pair-name"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            placeholder="My phone"
          />
          <p className="hint">Shown in the dashboard's paired-devices list so you can revoke it.</p>

          <button type="submit" className="primary block" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      )}

      {servers.length > 0 && (
        <button className="ghost block" onClick={() => navigate("/")}>
          Back to {servers[0].name}
        </button>
      )}
    </main>
  );
}
