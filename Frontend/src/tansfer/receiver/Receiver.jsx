/**
 * Receiver.jsx
 *
 * Receiver only needs to enter the 6-character code.
 * The encryption key is delivered automatically by the server
 * in the session-joined event — no manual key entry required.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { socket } from "../../socket";
import { createPeerConnection, buildReceiveHandler } from "../../webrtc";
import { importKeyHex } from "../../crypto";

export default function Receiver() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState("idle"); // idle | joining | waiting | receiving | done
  const [codeInput, setCodeInput] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [fileMeta, setFileMeta] = useState(null);
  const [received, setReceived] = useState(null); // { type, url, blob, name, mime, text }
  const [countdown, setCountdown] = useState(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const pcRef = useRef(null);
  const addIceCandidateRef = useRef(null);
  const countdownRef = useRef(null);
  const codeRef = useRef("");
  const senderIdRef = useRef("");
  const msgHandlerRef = useRef(null); // saved until the DataChannel opens

  // ── Join session (only code needed) ───────────────────────────────────────
  const joinSession = useCallback(() => {
    setError("");
    const code = codeInput.trim().toUpperCase();
    if (!code || code.length !== 6) {
      setError("Please enter the 6-character code shown by the sender.");
      return;
    }

    codeRef.current = code;
    setPhase("joining");
    socket.emit("join-session", { code });
  }, [codeInput]);

  // ── session-joined: server responds with key + sender info ─────────────────
  useEffect(() => {
    const handleSessionJoined = async ({ expiresAt, senderId, keyHex }) => {
      senderIdRef.current = senderId;

      // Import the encryption key delivered by the server
      let cryptoKey;
      try {
        cryptoKey = await importKeyHex(keyHex);
      } catch {
        setError("Key delivery failed. Please try again.");
        setPhase("idle");
        return;
      }

      // Build the DataChannel message handler now that we have the key
      msgHandlerRef.current = buildReceiveHandler(cryptoKey, {
        onMeta: (meta) => {
          setFileMeta(meta);
          setPhase("receiving");
          setProgress(0);
        },
        onProgress: setProgress,
        onFile: ({ name, mime, url, blob, size }) => {
          setReceived({ type: detectType(mime), url, blob, name, mime, size });
          setPhase("done");
        },
        onText: (text) => {
          setReceived({ type: "text", text });
          setPhase("done");
        },
        onError: (e) => setError("Transfer error: " + e.message),
      });

      // Start countdown
      let remaining = Math.floor((expiresAt - Date.now()) / 1000);
      setCountdown(remaining);
      countdownRef.current = setInterval(() => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) clearInterval(countdownRef.current);
      }, 1000);

      setPhase("waiting");
    };

    socket.on("session-joined", handleSessionJoined);
    return () => socket.off("session-joined", handleSessionJoined);
  }, []);

  // ── Receive WebRTC offer from sender ──────────────────────────────────────
  useEffect(() => {
    const handleOffer = async ({ offer, senderId, code }) => {
      if (code !== codeRef.current) return;
      senderIdRef.current = senderId;

      if (!msgHandlerRef.current) {
        setError("Key not ready. Please rejoin.");
        return;
      }

      const { pc, addIceCandidate, flushPendingCandidates } = createPeerConnection({
        onIceCandidate: (candidate) => {
          socket.emit("ice-candidate", {
            code: codeRef.current,
            candidate,
            targetId: senderId,
          });
        },
      });

      addIceCandidateRef.current = addIceCandidate;

      // Receiver side — DataChannel is opened by sender
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = "arraybuffer";
        channel.onmessage = msgHandlerRef.current;
        channel.onopen = () => setPhase("waiting"); // still waiting for send
        channel.onclose = () => console.log("[DC] Closed");
      };

      await pc.setRemoteDescription(offer);
      await flushPendingCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("send-answer", {
        code: codeRef.current,
        answer: pc.localDescription,
        senderId,
      });

      pcRef.current = pc;
    };

    socket.on("receive-offer", handleOffer);
    return () => socket.off("receive-offer", handleOffer);
  }, []);

  // ── ICE candidates from sender ────────────────────────────────────────────
  useEffect(() => {
    const handleIce = ({ candidate, fromId }) => {
      if (fromId !== senderIdRef.current) return;
      addIceCandidateRef.current?.(candidate);
    };
    socket.on("ice-candidate", handleIce);
    return () => socket.off("ice-candidate", handleIce);
  }, []);

  // ── Session expired ───────────────────────────────────────────────────────
  useEffect(() => {
    const handleExpired = ({ code }) => {
      if (code !== codeRef.current) return;
      clearInterval(countdownRef.current);
      setError("Session expired.");
      setPhase("idle");
    };
    socket.on("code-expired", handleExpired);
    return () => socket.off("code-expired", handleExpired);
  }, []);

  // ── Server errors ─────────────────────────────────────────────────────────
  useEffect(() => {
    const handleError = ({ msg }) => {
      setError(msg);
      setPhase("idle");
    };
    socket.on("error-event", handleError);
    return () => socket.off("error-event", handleError);
  }, []);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(countdownRef.current);
      pcRef.current?.close();
    };
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function detectType(mime = "") {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
  }

  function downloadFile() {
    if (!received?.url) return;
    const a = document.createElement("a");
    a.href = received.url;
    a.download = received.name || "download";
    a.click();
  }

  function resetState() {
    setPhase("idle");
    setReceived(null);
    setFileMeta(null);
    setProgress(0);
    setError("");
    setCodeInput("");
    setCountdown(null);
    pcRef.current?.close();
    pcRef.current = null;
    msgHandlerRef.current = null;
    codeRef.current = "";
    senderIdRef.current = "";
    clearInterval(countdownRef.current);
  }

  const countdownColor =
    countdown > 60 ? "#10b981" : countdown > 30 ? "#f59e0b" : "#ef4444";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="card receiver-card">
      <h2 className="card-title">
        <span className="icon-badge">📥</span> Receive
      </h2>

      {error && <div className="alert alert-error">{error}</div>}

      {/* ── IDLE / JOINING: only ask for the code ── */}
      {(phase === "idle" || phase === "joining") && (
        <div className="join-form">
          <p className="hint">
            Enter the 6-character code shown on the sender's screen.
            <br />
            <span style={{ color: "var(--success)", fontSize: "0.82rem", marginTop: 4, display: "block" }}>
              🔒 Encryption key is transferred automatically — nothing else needed.
            </span>
          </p>

          <div className="input-group">
            <label className="input-label" htmlFor="code-input">Session Code</label>
            <input
              id="code-input"
              className="text-field code-field-large"
              placeholder="AB12CD"
              maxLength={6}
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && joinSession()}
              disabled={phase === "joining"}
              autoFocus
              spellCheck={false}
            />
          </div>

          <button
            id="join-btn"
            className="btn btn-secondary"
            onClick={joinSession}
            disabled={phase === "joining" || codeInput.trim().length !== 6}
          >
            {phase === "joining" ? "⏳ Joining…" : "🔗 Join Session"}
          </button>
        </div>
      )}

      {/* ── WAITING: connected, waiting for sender to transmit ── */}
      {phase === "waiting" && (
        <div className="center-col" style={{ gap: 16 }}>
          <div className="spinner" />
          <p className="hint">
            ✅ Connected &amp; key received — waiting for sender to transmit…
          </p>
          {countdown !== null && (
            <div className="countdown-badge" style={{ color: countdownColor }}>
              ⏱ {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")} remaining
            </div>
          )}
        </div>
      )}

      {/* ── RECEIVING: progress bar ── */}
      {phase === "receiving" && (
        <div className="center-col">
          {fileMeta && (
            <p className="hint">
              Receiving <strong>{fileMeta.name}</strong>
              {fileMeta.size
                ? ` — ${(fileMeta.size / 1024 / 1024).toFixed(2)} MB`
                : ""}
            </p>
          )}
          <div className="progress-wrap">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="progress-pct">{progress}%</span>
        </div>
      )}

      {/* ── DONE: preview + download ── */}
      {phase === "done" && received && (
        <div className="preview-area">
          {received.type === "text" && (
            <div className="text-preview">
              <p className="preview-label">📋 Received Text</p>
              <pre className="text-content">{received.text}</pre>
              <button
                className="btn btn-outline"
                onClick={() => navigator.clipboard.writeText(received.text)}
              >
                📋 Copy to Clipboard
              </button>
            </div>
          )}

          {received.type === "image" && (
            <div className="media-preview">
              <p className="preview-label">🖼 Image received</p>
              <img src={received.url} alt={received.name} className="preview-img" />
              <button className="btn btn-outline" onClick={downloadFile}>
                ⬇ Download
              </button>
            </div>
          )}

          {received.type === "video" && (
            <div className="media-preview">
              <p className="preview-label">🎬 Video received</p>
              <video src={received.url} controls className="preview-video" />
              <button className="btn btn-outline" onClick={downloadFile}>
                ⬇ Download
              </button>
            </div>
          )}

          {received.type === "audio" && (
            <div className="media-preview">
              <p className="preview-label">🎵 Audio received</p>
              <audio src={received.url} controls className="preview-audio" />
              <button className="btn btn-outline" onClick={downloadFile}>
                ⬇ Download
              </button>
            </div>
          )}

          {received.type === "file" && (
            <div className="media-preview">
              <p className="preview-label">
                📁 {received.name}
                {received.size
                  ? ` (${(received.size / 1024 / 1024).toFixed(2)} MB)`
                  : ""}
              </p>
              <button className="btn btn-outline" onClick={downloadFile}>
                ⬇ Download
              </button>
            </div>
          )}

          <button className="btn btn-ghost" onClick={resetState}>
            🔄 Receive Another
          </button>
        </div>
      )}
    </div>
  );
}
