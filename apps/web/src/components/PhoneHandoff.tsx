import { useEffect, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { api } from "../lib/api";

const DISMISSED_KEY = "survhub_phone_handoff_dismissed";

type AuthStatus = {
  companionApp?: { mounted: boolean; path: string } | null;
};

/**
 * Hand a phone the companion app instead of the desktop dashboard.
 *
 * The dashboard is responsive, which turns out to be the trap: opening this
 * control plane on a phone gives you the desktop UI at phone width, and it looks
 * enough like "the mobile version" that you never find out there is a real one
 * behind a pairing code. Someone who scans the pairing QR and lands here has
 * gone precisely the wrong way.
 *
 * So when a phone arrives and this machine is serving the companion app, say so
 * once, offer both doors, and remember which one was taken. Never a redirect:
 * the dashboard on a phone is a legitimate thing to want — it is just rarely
 * what someone with a pairing code in their hand wants.
 */
export function isPhoneViewport(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  // Coarse pointer AND a phone-ish UA: either alone is wrong. A touchscreen
  // laptop has the pointer, and a desktop-mode request from a tablet has neither.
  const phoneUa = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua);
  const narrow = window.matchMedia?.("(max-width: 820px)").matches ?? window.innerWidth <= 820;
  return phoneUa && narrow;
}

export function PhoneHandoff() {
  const [appPath, setAppPath] = useState<string | null>(null);

  useEffect(() => {
    if (!isPhoneViewport()) return;
    try {
      if (localStorage.getItem(DISMISSED_KEY) === "1") return;
    } catch {
      /* private mode — show it, it is one tap to dismiss */
    }
    void (async () => {
      try {
        const status = await api<AuthStatus>("/auth/status", { silent: true });
        if (status.companionApp?.mounted) setAppPath(status.companionApp.path);
      } catch {
        /* offer nothing rather than a broken link */
      }
    })();
  }, []);

  if (!appPath) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* the sheet just reappears next visit; not worth failing over */
    }
    setAppPath(null);
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="phone-handoff-title">
      <div className="modal-content" style={{ width: "min(100%, 420px)" }}>
        <div className="modal-header">
          <h3 id="phone-handoff-title">
            <Smartphone size={20} style={{ verticalAlign: "-3px", marginRight: "0.5rem" }} />
            You're on a phone
          </h3>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0 }}>
            This machine has a companion app built for a phone screen — pair it once with the code from{" "}
            <strong>Settings → Companion</strong>, then check on your services and start, stop or redeploy
            them from anywhere.
          </p>
          <p className="muted small">
            The dashboard works here too; it is just the desktop UI at phone width.
          </p>
        </div>
        <div className="modal-footer" style={{ display: "grid", gap: "0.6rem" }}>
          <a className="primary" href={`${appPath}/`} style={{ textAlign: "center" }}>
            <Smartphone size={16} style={{ verticalAlign: "-3px", marginRight: "0.4rem" }} />
            Open the companion app
          </a>
          <button className="ghost" onClick={dismiss}>
            <Monitor size={16} style={{ verticalAlign: "-3px", marginRight: "0.4rem" }} />
            Continue to the dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
