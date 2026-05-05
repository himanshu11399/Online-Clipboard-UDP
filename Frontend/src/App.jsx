import { useState } from "react";
import Sender from "./tansfer/sender/Sender";
import Receiver from "./tansfer/receiver/Receiver";
import "./App.css";

export default function App() {
  const [tab, setTab] = useState("sender"); // "sender" | "receiver"

  return (
    <div className="app-root">
      {/* ── Hero Header ─────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            <span className="logo-text">SecureShare</span>
          </div>
          <p className="tagline">
            Peer-to-peer · End-to-end encrypted · No server storage
          </p>

          {/* Feature pills */}
          <div className="feature-pills">
            {["🔒 AES-256", "⚡ WebRTC P2P", "💾 No Storage", "⏱ 2-min Expiry"].map((f) => (
              <span key={f} className="pill">{f}</span>
            ))}
          </div>
        </div>
      </header>

      {/* ── Tab Switcher ─────────────────────────────────────────────────── */}
      <nav className="tab-bar">
        <button
          id="tab-sender"
          className={`tab-btn ${tab === "sender" ? "active" : ""}`}
          onClick={() => setTab("sender")}
        >
          📤 Send
        </button>
        <button
          id="tab-receiver"
          className={`tab-btn ${tab === "receiver" ? "active" : ""}`}
          onClick={() => setTab("receiver")}
        >
          📥 Receive
        </button>
      </nav>

      {/* ── Main Panel ───────────────────────────────────────────────────── */}
      <main className="main-panel">
        {tab === "sender" ? <Sender /> : <Receiver />}
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="app-footer">
        <p>
          All transfers are direct peer-to-peer. No data ever touches our servers.
        </p>
      </footer>
    </div>
  );
}
