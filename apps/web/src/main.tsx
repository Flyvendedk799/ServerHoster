import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastContainer } from "./components/ToastContainer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import "./styles.css";

// Apply saved theme on first render so there's no flash.
const savedTheme = localStorage.getItem("survhub_theme");
if (savedTheme === "light" || savedTheme === "dark") {
  document.documentElement.setAttribute("data-theme", savedTheme);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
        <ToastContainer />
        <ConfirmDialog />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
