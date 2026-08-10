import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

// Hash routing on purpose: this bundle has to work when it is dropped onto a
// dumb static host, or served from a subpath by the control plane itself, with
// nobody configuring an SPA rewrite. It also makes the pairing deep link
// (#/pair?s=…&c=…) keep its parameters out of any server's access log.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    // Failing to register is not worth surfacing: the app works online without
    // it, and the only thing lost is offline launch.
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
