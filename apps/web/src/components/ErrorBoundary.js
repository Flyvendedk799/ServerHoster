import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
export class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }
  reset = () => {
    this.setState({ error: null });
  };
  render() {
    if (this.state.error) {
      return _jsxs("div", {
        style: {
          padding: "2rem",
          margin: "2rem auto",
          maxWidth: "640px",
          background: "#1e1b1b",
          border: "1px solid #b91c1c",
          borderRadius: "8px",
          color: "#fecaca",
          fontFamily: "system-ui, sans-serif"
        },
        children: [
          _jsx("h2", { style: { marginTop: 0 }, children: "Something went wrong" }),
          _jsx("p", { children: "The dashboard hit a rendering error. This is a bug in the UI." }),
          _jsx("pre", {
            style: {
              background: "#0f0f0f",
              padding: "1rem",
              borderRadius: "4px",
              overflowX: "auto",
              fontSize: "0.85rem"
            },
            children: this.state.error.message
          }),
          _jsx("button", {
            onClick: this.reset,
            style: {
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              background: "#b91c1c",
              border: "none",
              borderRadius: "4px",
              color: "white",
              cursor: "pointer"
            },
            children: "Try again"
          }),
          _jsx("button", {
            onClick: () => window.location.reload(),
            style: {
              marginLeft: "0.5rem",
              padding: "0.5rem 1rem",
              background: "#334155",
              border: "none",
              borderRadius: "4px",
              color: "white",
              cursor: "pointer"
            },
            children: "Reload page"
          })
        ]
      });
    }
    return this.props.children;
  }
}
