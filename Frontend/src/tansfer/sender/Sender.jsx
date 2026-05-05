/**
 * Sender.jsx
 *
 * Auto-transfer: as soon as a receiver's DataChannel opens,
 * the selected file / text is sent immediately — no button click required.
 *
 * If no content is selected yet when the channel opens,
 * we mark the receiver as "waiting" and send the moment the user picks content.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { socket } from "../../socket";
import { createPeerConnection, sendFile, sendText } from "../../webrtc";
import { generateKey, exportKeyHex } from "../../crypto";

const CODE_TTL = 600; // seconds — must match CODE_TTL_MS in server.js (currently 10 min)

export default function Sender() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState("idle"); // idle | setup | transferring | done
  const [code, setCode] = useState("");
  const [qrPayload, setQrPayload] = useState("");
  const [countdown, setCountdown] = useState(CODE_TTL);
  const [receivers, setReceivers] = useState([]);       // [{ id, progress, status }]
  const [selectedFile, setSelectedFile] = useState(null);
  const [textInput, setTextInput] = useState("");
  const [transferMode, setTransferMode] = useState("file"); // file | text
  const [error, setError] = useState("");
  const [sessionStarted, setSessionStarted] = useState(false);

  // ── Refs — mirrors of state so callbacks always read current values ─────────
  const cryptoKeyRef    = useRef(null);
  const peersRef        = useRef({});       // { [receiverId]: { pc, channel, addIceCandidate } }
  const countdownRef    = useRef(null);
  const codeRef         = useRef("");
  const selectedFileRef = useRef(null);     // mirrors selectedFile state
  const textInputRef    = useRef("");       // mirrors textInput state
  const transferModeRef = useRef("file");   // mirrors transferMode state

  // Keep refs in sync with state
  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);
  useEffect(() => { textInputRef.current    = textInput;    }, [textInput]);
  useEffect(() => { transferModeRef.current = transferMode; }, [transferMode]);

  // ── Auto-send to a single channel ─────────────────────────────────────────
  // Called from channel.onopen — reads refs so it always has fresh values.
  const autoSendToChannel = useCallback(async (channel, receiverId) => {
    const mode = transferModeRef.current;
    const file = selectedFileRef.current;
    const text = textInputRef.current;

    if (!cryptoKeyRef.current) return;

    // Nothing selected yet — mark as waiting; sendPendingToAll() will fire later
    if (mode === "file" && !file) return;
    if (mode === "text" && !text.trim()) return;

    setPhase("transferring");
    setReceivers((prev) =>
      prev.map((r) => (r.id === receiverId ? { ...r, status: "sending" } : r))
    );

    if (mode === "text") {
      await sendText(channel, text, cryptoKeyRef.current).catch(console.error);
      setReceivers((prev) =>
        prev.map((r) => (r.id === receiverId ? { ...r, status: "done", progress: 100 } : r))
      );
      setPhase("setup");
    } else {
      await sendFile(channel, file, cryptoKeyRef.current, {
        onProgress: (pct) =>
          setReceivers((prev) =>
            prev.map((r) => (r.id === receiverId ? { ...r, progress: pct } : r))
          ),
        onDone: () => {
          setReceivers((prev) =>
            prev.map((r) => (r.id === receiverId ? { ...r, status: "done", progress: 100 } : r))
          );
          // Check if all are done
          setPhase("setup");
        },
        onError: (e) => console.error("[send error]", receiverId, e),
      });
    }
  }, []);

  // ── Send to any channels that opened before content was selected ───────────
  // Called when user picks a file or types text while receivers are already waiting.
  const sendPendingToAll = useCallback(() => {
    for (const [rid, { channel }] of Object.entries(peersRef.current)) {
      if (channel.readyState === "open") {
        // Only send to receivers that are still in "connected" (not already sent)
        setReceivers((prev) => {
          const r = prev.find((x) => x.id === rid);
          if (r && r.status === "connected") {
            // Fire async without blocking render
            autoSendToChannel(channel, rid);
          }
          return prev;
        });
      }
    }
  }, [autoSendToChannel]);

  // ── Start session ──────────────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    setError("");
    try {
      const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const key     = await generateKey();
      const hex     = await exportKeyHex(key);

      cryptoKeyRef.current = key;
      codeRef.current      = newCode;
      setCode(newCode);
      setQrPayload(newCode);

      socket.emit("register-code", { code: newCode, keyHex: hex });
      setPhase("setup");
      setSessionStarted(true);
      setCountdown(CODE_TTL);

      let remaining = CODE_TTL;
      countdownRef.current = setInterval(() => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) clearInterval(countdownRef.current);
      }, 1000);
    } catch (e) {
      setError("Failed to start session: " + e.message);
    }
  }, []);

  // ── Handle a new receiver joining ─────────────────────────────────────────
  useEffect(() => {
    const handleReceiverJoined = async ({ receiverId, code: c }) => {
      if (c !== codeRef.current) return;
      if (peersRef.current[receiverId]) return;

      setReceivers((prev) => [
        ...prev,
        { id: receiverId, progress: 0, status: "connecting" },
      ]);

      const { pc, addIceCandidate, flushPendingCandidates } = createPeerConnection({
        onIceCandidate: (candidate) => {
          socket.emit("ice-candidate", {
            code: codeRef.current,
            candidate,
            targetId: receiverId,
          });
        },
      });

      const channel = pc.createDataChannel("transfer", { ordered: true });

      channel.onopen = () => {
        // Mark connected
        setReceivers((prev) =>
          prev.map((r) => (r.id === receiverId ? { ...r, status: "connected" } : r))
        );
        // ── AUTO-SEND immediately when channel opens ──────────────────────
        autoSendToChannel(channel, receiverId);
      };

      channel.onclose = () => {
        setReceivers((prev) =>
          prev.map((r) => (r.id === receiverId ? { ...r, status: "closed" } : r))
        );
      };

      peersRef.current[receiverId] = { pc, channel, addIceCandidate };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("send-offer", {
        code: codeRef.current,
        receiverId,
        offer: pc.localDescription,
      });

      const handleAnswer = ({ answer, receiverId: rid }) => {
        if (rid !== receiverId) return;
        pc.setRemoteDescription(answer)
          .then(flushPendingCandidates)
          .catch(console.error);
      };
      socket.on("receive-answer", handleAnswer);
      peersRef.current[receiverId].cleanupAnswer = () =>
        socket.off("receive-answer", handleAnswer);
    };

    socket.on("receiver-joined", handleReceiverJoined);
    return () => socket.off("receiver-joined", handleReceiverJoined);
  }, [autoSendToChannel]);

  // ── ICE candidates ─────────────────────────────────────────────────────────
  useEffect(() => {
    const handleIce = ({ candidate, fromId }) => {
      peersRef.current[fromId]?.addIceCandidate(candidate);
    };
    socket.on("ice-candidate", handleIce);
    return () => socket.off("ice-candidate", handleIce);
  }, []);

  // ── Code expiry ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleExpired = ({ code: c }) => {
      if (c !== codeRef.current) return;
      clearInterval(countdownRef.current);
      setPhase("done");
      setError("Session expired. Start a new one.");
    };
    socket.on("code-expired", handleExpired);
    return () => socket.off("code-expired", handleExpired);
  }, []);

  // ── Server errors ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handleError = ({ msg }) => setError(msg);
    socket.on("error-event", handleError);
    return () => socket.off("error-event", handleError);
  }, []);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(countdownRef.current);
      Object.values(peersRef.current).forEach(({ pc, cleanupAnswer }) => {
        cleanupAnswer?.();
        pc.close();
      });
    };
  }, []);

  // ── When user picks file/text AFTER a receiver is already connected ────────
  // We trigger send to any open-but-waiting channels.
  const handleFileChange = (file) => {
    setSelectedFile(file);
    selectedFileRef.current = file;
    // Small timeout so ref updates before sendPendingToAll reads it
    setTimeout(sendPendingToAll, 50);
  };

  const handleTextChange = (text) => {
    setTextInput(text);
    textInputRef.current = text;
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const countdownColor =
    countdown > 60 ? "#10b981" : countdown > 30 ? "#f59e0b" : "#ef4444";

  const hasContent =
    transferMode === "file" ? !!selectedFile : textInput.trim().length > 0;

  const readyToReceive = sessionStarted && !hasContent;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="card sender-card">
      <h2 className="card-title">
        <span className="icon-badge">📤</span> Send
      </h2>

      {error && <div className="alert alert-error">{error}</div>}

      {/* ── IDLE ── */}
      {phase === "idle" && (
        <div className="center-col">
          <p className="hint">
            Pick your file or text, then start a session.
            <br />Transfer begins automatically when a receiver joins.
          </p>

          {/* Pre-session content picker */}
          <div className="mode-toggle" style={{ width: "100%" }}>
            <button
              className={`toggle-btn ${transferMode === "file" ? "active" : ""}`}
              onClick={() => setTransferMode("file")}
            >
              📁 File
            </button>
            <button
              className={`toggle-btn ${transferMode === "text" ? "active" : ""}`}
              onClick={() => setTransferMode("text")}
            >
              📝 Text
            </button>
          </div>

          {transferMode === "file" && (
            <label className="file-drop" style={{ width: "100%" }}>
              <input
                type="file"
                hidden
                onChange={(e) => handleFileChange(e.target.files[0])}
              />
              {selectedFile ? (
                <span className="file-name">
                  📎 {selectedFile.name}{" "}
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                    ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
                  </span>
                </span>
              ) : (
                <span>Click or drag a file here</span>
              )}
            </label>
          )}

          {transferMode === "text" && (
            <textarea
              className="text-input"
              style={{ width: "100%" }}
              placeholder="Type text to send…"
              value={textInput}
              onChange={(e) => handleTextChange(e.target.value)}
              rows={4}
            />
          )}

          <button
            id="start-session-btn"
            className="btn btn-primary"
            onClick={startSession}
          >
            🚀 Start Session
          </button>
        </div>
      )}

      {/* ── SETUP / TRANSFERRING / DONE ── */}
      {(phase === "setup" || phase === "transferring") && (
        <>
          {/* Code + QR */}
          <div className="session-info">
            <div className="code-display">
              <span className="code-label">Share Code</span>
              <span className="code-value">{code}</span>
              <span className="countdown" style={{ color: countdownColor }}>
                ⏱ {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
              </span>
            </div>

            {qrPayload && (
              <div className="qr-wrapper">
                <QRCodeSVG
                  value={qrPayload}
                  size={160}
                  bgColor="#13162b"
                  fgColor="#c4b5fd"
                  level="M"
                  style={{
                    borderRadius: 8,
                    border: "2px solid rgba(139,92,246,0.4)",
                    padding: 8,
                  }}
                />
                <p className="qr-hint">Scan or enter code — transfers instantly</p>
              </div>
            )}
          </div>

          {/* Content being sent */}
          <div className="content-summary">
            {transferMode === "file" && selectedFile ? (
              <div className="content-badge">
                <span className="content-icon">📁</span>
                <div className="content-info">
                  <span className="content-name">{selectedFile.name}</span>
                  <span className="content-size">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
                {phase !== "transferring" && (
                  <label className="change-file-btn">
                    <input
                      type="file"
                      hidden
                      onChange={(e) => handleFileChange(e.target.files[0])}
                    />
                    Change
                  </label>
                )}
              </div>
            ) : transferMode === "text" && textInput.trim() ? (
              <div className="content-badge">
                <span className="content-icon">📝</span>
                <span className="content-name" style={{ fontStyle: "italic" }}>
                  {textInput.slice(0, 60)}{textInput.length > 60 ? "…" : ""}
                </span>
              </div>
            ) : (
              /* No content yet — show picker inline */
              <div className="auto-send-notice">
                <div className="mode-toggle">
                  <button
                    className={`toggle-btn ${transferMode === "file" ? "active" : ""}`}
                    onClick={() => setTransferMode("file")}
                  >
                    📁 File
                  </button>
                  <button
                    className={`toggle-btn ${transferMode === "text" ? "active" : ""}`}
                    onClick={() => setTransferMode("text")}
                  >
                    📝 Text
                  </button>
                </div>

                {transferMode === "file" && (
                  <label className="file-drop">
                    <input
                      type="file"
                      hidden
                      onChange={(e) => handleFileChange(e.target.files[0])}
                    />
                    <span>Click to pick a file — sends automatically on join</span>
                  </label>
                )}
                {transferMode === "text" && (
                  <textarea
                    className="text-input"
                    placeholder="Type text to send…"
                    value={textInput}
                    onChange={(e) => handleTextChange(e.target.value)}
                    rows={3}
                  />
                )}
              </div>
            )}
          </div>

          {/* Auto-send indicator */}
          {readyToReceive && (
            <div className="auto-badge">
              ⚡ Transfer will start automatically when someone joins
            </div>
          )}
          {hasContent && phase === "setup" && receivers.length === 0 && (
            <div className="auto-badge ready">
              ✅ Ready — waiting for a receiver to join…
            </div>
          )}

          {/* Receivers list */}
          {receivers.length > 0 && (
            <div className="receivers-list">
              <h3 className="section-title">
                Receivers ({receivers.length})
              </h3>
              {receivers.map((r) => (
                <div key={r.id} className="receiver-item">
                  <span className={`status-dot status-${r.status}`} />
                  <span className="receiver-id">{r.id.slice(0, 8)}…</span>
                  <span className="receiver-status">{r.status}</span>
                  {r.progress > 0 && r.progress < 100 && (
                    <div className="progress-bar-wrap">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${r.progress}%` }}
                      />
                    </div>
                  )}
                  {r.progress > 0 && (
                    <span className="progress-label">{r.progress}%</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── SESSION ENDED ── */}
      {phase === "done" && (
        <div className="center-col">
          <p className="hint">Session ended.</p>
          <button
            className="btn btn-primary"
            onClick={() => {
              setPhase("idle");
              setSessionStarted(false);
              setReceivers([]);
              setSelectedFile(null);
              selectedFileRef.current = null;
              setTextInput("");
              textInputRef.current = "";
              setError("");
              setQrPayload("");
              peersRef.current = {};
            }}
          >
            🔄 New Session
          </button>
        </div>
      )}
    </div>
  );
}
