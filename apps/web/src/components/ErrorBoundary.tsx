import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{
          padding: "2rem",
          margin: "2rem auto",
          maxWidth: "640px",
          background: "#1e1b1b",
          border: "1px solid #b91c1c",
          borderRadius: "8px",
          color: "#fecaca",
          fontFamily: "system-ui, sans-serif"
        }}>
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <p>The dashboard hit a rendering error. This is a bug in the UI.</p>
          <pre style={{
            background: "#0f0f0f",
            padding: "1rem",
            borderRadius: "4px",
            overflowX: "auto",
            fontSize: "0.85rem"
          }}>{this.state.error.message}</pre>
          <button
            onClick={this.reset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              background: "#b91c1c",
              border: "none",
              borderRadius: "4px",
              color: "white",
              cursor: "pointer"
            }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginLeft: "0.5rem",
              padding: "0.5rem 1rem",
              background: "#334155",
              border: "none",
              borderRadius: "4px",
              color: "white",
              cursor: "pointer"
            }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
