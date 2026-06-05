import React from "react";

// Top-level React error boundary. Without this, any uncaught render error in
// a single tab blanks the whole SPA. We catch, log to console, and show a
// minimal recovery UI so the user can keep using the site.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div style={{
        maxWidth: 640,
        margin: "80px auto",
        padding: "24px 28px",
        background: "var(--bg-panel, #111)",
        border: "1px solid var(--danger, #ff4444)",
        fontFamily: "var(--font-mono, monospace)",
        color: "var(--text, #ddd)",
      }}>
        <div style={{
          color: "var(--danger, #ff4444)",
          fontSize: 13,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          marginBottom: 12,
        }}>
          ⚠ Something broke
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
          The page hit an unrecoverable error. Your work in other tabs may still
          be safe — try resetting this view first, then reload if it persists.
        </div>
        <pre style={{
          background: "rgba(255,68,68,0.08)",
          border: "1px solid rgba(255,68,68,0.3)",
          padding: 10,
          fontSize: 11,
          color: "var(--danger, #ff4444)",
          overflow: "auto",
          maxHeight: 200,
          whiteSpace: "pre-wrap",
          marginBottom: 16,
        }}>{msg}</pre>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={this.handleReset}
            style={{
              background: "transparent",
              border: "1px solid var(--accent-dim, #555)",
              color: "var(--text, #ddd)",
              padding: "6px 14px",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 12,
              letterSpacing: "0.06em",
              cursor: "pointer",
            }}
          >
            ↺ RESET VIEW
          </button>
          <button
            onClick={this.handleReload}
            style={{
              background: "transparent",
              border: "1px solid var(--accent-dim, #555)",
              color: "var(--text, #ddd)",
              padding: "6px 14px",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 12,
              letterSpacing: "0.06em",
              cursor: "pointer",
            }}
          >
            ↻ RELOAD PAGE
          </button>
        </div>
      </div>
    );
  }
}
