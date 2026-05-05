/**
 * webrtc.js  –  Robust RTCPeerConnection factory + DataChannel file-transfer engine
 *
 * Key fixes vs. original:
 *  • Multiple STUN/TURN servers for reliability
 *  • ICE candidate buffering (candidates received before remoteDescription is set are queued)
 *  • DataChannel chunk-based transfer with 16 KB chunks
 *  • Backpressure: pauses sending when bufferedAmount exceeds threshold
 *  • Progress callbacks
 *  • Automatic file-type detection on receiver side
 */

import { encrypt, decrypt } from "./crypto";

// ─── ICE Configuration ────────────────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // Free TURN fallback (replace with your own for production)
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 10,
};

const CHUNK_SIZE = 16 * 1024; // 16 KB per chunk
const BUFFER_THRESHOLD = 256 * 1024; // 256 KB – pause when bufferedAmount > this
const BUFFER_RESUME = 64 * 1024; // 64 KB  – resume when bufferedAmount drops below

// ─── Peer factory ─────────────────────────────────────────────────────────────
/**
 * Create a configured RTCPeerConnection with ICE candidate buffering.
 *
 * @param {object} opts
 * @param {function} opts.onIceCandidate  – called with (candidate) to forward to signaling
 * @returns {{ pc: RTCPeerConnection, addIceCandidate: function }}
 */
export function createPeerConnection({ onIceCandidate }) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  // Buffer candidates that arrive before remoteDescription is set
  let pendingCandidates = [];
  let remoteSet = false;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) onIceCandidate(candidate);
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[ICE] State: ${pc.iceConnectionState}`);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[PC] State: ${pc.connectionState}`);
  };

  /**
   * Call this whenever a remote ICE candidate arrives from signaling.
   * Buffers candidates until the remote description is applied.
   */
  async function addIceCandidate(candidate) {
    if (!candidate) return;
    const rtcCandidate = new RTCIceCandidate(candidate);

    if (remoteSet) {
      await pc.addIceCandidate(rtcCandidate).catch(console.error);
    } else {
      pendingCandidates.push(rtcCandidate);
    }
  }

  /**
   * Must be called after pc.setRemoteDescription() so buffered candidates flush.
   */
  async function flushPendingCandidates() {
    remoteSet = true;
    for (const c of pendingCandidates) {
      await pc.addIceCandidate(c).catch(console.error);
    }
    pendingCandidates = [];
  }

  return { pc, addIceCandidate, flushPendingCandidates };
}

// ─── File Sender ──────────────────────────────────────────────────────────────
/**
 * Send a File (or Blob) over an open RTCDataChannel with:
 *  – chunking (CHUNK_SIZE)
 *  – AES-GCM encryption per chunk
 *  – backpressure handling
 *  – progress reporting
 *
 * @param {RTCDataChannel} channel  – must already be open
 * @param {File|Blob} file
 * @param {CryptoKey} cryptoKey
 * @param {object} callbacks
 * @param {function} callbacks.onProgress  – (pct: number) => void
 * @param {function} callbacks.onDone      – () => void
 * @param {function} callbacks.onError     – (err) => void
 * @returns {{ cancel: function }} – call cancel() to abort the transfer
 */
export async function sendFile(channel, file, cryptoKey, { onProgress, onDone, onError } = {}) {
  let cancelled = false;

  // ── 1. Send metadata header ────────────────────────────────────────────────
  const header = JSON.stringify({
    type: "file-meta",
    name: file.name,
    size: file.size,
    mime: file.type,
    chunks: Math.ceil(file.size / CHUNK_SIZE),
  });
  channel.send(header);

  // ── 2. Read + encrypt + send each chunk ───────────────────────────────────
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let chunkIndex = 0;
  let offset = 0;

  async function sendNextChunk() {
    if (cancelled) return;
    if (offset >= file.size) {
      // Signal end-of-file
      const eof = JSON.stringify({ type: "file-eof", name: file.name });
      channel.send(eof);
      onDone?.();
      return;
    }

    // Backpressure: wait if buffer is full
    if (channel.bufferedAmount > BUFFER_THRESHOLD) {
      await waitForDrain(channel);
      if (cancelled) return;
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const raw = await slice.arrayBuffer();
    const cipher = await encrypt(cryptoKey, raw).catch((e) => {
      onError?.(e);
      return null;
    });
    if (!cipher) return;

    channel.send(cipher);

    offset += CHUNK_SIZE;
    chunkIndex++;
    onProgress?.(Math.round((chunkIndex / totalChunks) * 100));

    // Yield to event loop so the browser doesn't freeze
    setTimeout(sendNextChunk, 0);
  }

  sendNextChunk().catch(onError);

  return { cancel: () => { cancelled = true; } };
}

/**
 * Send a plain text message over the channel (also encrypted).
 */
export async function sendText(channel, text, cryptoKey) {
  const header = JSON.stringify({ type: "text-meta" });
  channel.send(header);

  const encoded = new TextEncoder().encode(text);
  const cipher = await encrypt(cryptoKey, encoded);
  channel.send(cipher);

  channel.send(JSON.stringify({ type: "text-eof" }));
}

// ─── Backpressure helper ──────────────────────────────────────────────────────
function waitForDrain(channel) {
  return new Promise((resolve) => {
    const check = () => {
      if (channel.bufferedAmount <= BUFFER_RESUME) {
        resolve();
      } else {
        channel.bufferedAmountLowThreshold = BUFFER_RESUME;
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          resolve();
        };
      }
    };
    check();
  });
}

// ─── File Receiver ────────────────────────────────────────────────────────────
/**
 * Build a stateful message handler for the receiver's DataChannel.
 * Returns a function to pass to channel.onmessage.
 *
 * @param {CryptoKey} cryptoKey
 * @param {object} callbacks
 * @param {function} callbacks.onMeta      – ({ name, size, mime, chunks }) => void
 * @param {function} callbacks.onProgress  – (pct: number) => void
 * @param {function} callbacks.onFile      – ({ name, mime, url, blob }) => void
 * @param {function} callbacks.onText      – (text: string) => void
 * @param {function} callbacks.onError     – (err) => void
 * @returns {function}  – assign this to channel.onmessage
 */
export function buildReceiveHandler(cryptoKey, { onMeta, onProgress, onFile, onText, onError } = {}) {
  let mode = null;        // "file" | "text"
  let meta = null;        // file metadata
  let chunks = [];        // received file chunks (ArrayBuffer[])
  let received = 0;       // chunks received so far

  return async function handleMessage(event) {
    const { data } = event;

    // ── JSON control messages ────────────────────────────────────────────────
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === "file-meta") {
        mode = "file";
        meta = msg;
        chunks = [];
        received = 0;
        onMeta?.(msg);
        return;
      }

      if (msg.type === "text-meta") {
        mode = "text";
        chunks = [];
        received = 0;
        return;
      }

      if (msg.type === "file-eof") {
        if (mode !== "file" || !meta) return;
        const blob = new Blob(chunks, { type: meta.mime });
        const url = URL.createObjectURL(blob);
        onFile?.({ name: meta.name, mime: meta.mime, url, blob, size: meta.size });
        // reset
        mode = null; meta = null; chunks = []; received = 0;
        return;
      }

      if (msg.type === "text-eof") {
        if (mode !== "text") return;
        // Wait — chunks will be decrypted in the binary branch below; eof means
        // the single text chunk was already handled (see binary branch)
        return;
      }

      return;
    }

    // ── Binary chunk (encrypted) ─────────────────────────────────────────────
    if (data instanceof ArrayBuffer) {
      let plain;
      try {
        plain = await decrypt(cryptoKey, data);
      } catch (e) {
        onError?.(new Error("Decryption failed: " + e.message));
        return;
      }

      if (mode === "file") {
        chunks.push(plain);
        received++;
        if (meta?.chunks) onProgress?.(Math.round((received / meta.chunks) * 100));
      }

      if (mode === "text") {
        const text = new TextDecoder().decode(plain);
        onText?.(text);
      }
    }
  };
}
