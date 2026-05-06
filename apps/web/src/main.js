import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
createRoot(document.getElementById("root")).render(
  _jsx(React.StrictMode, {
    children: _jsx(ErrorBoundary, {
      children: _jsxs(BrowserRouter, {
        children: [_jsx(App, {}), _jsx(ToastContainer, {}), _jsx(ConfirmDialog, {})]
      })
    })
  })
);
