import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Increase buffer size for ICE candidate bursts
  maxHttpBufferSize: 1e6,
});

// ─── In-memory session store ─────────────────────────────────────────────────
// Structure: Map<code, { senderSocketId, keyHex, receivers: Set<socketId>, expiresAt, timer }>
// keyHex is the AES-256 key in hex — stored ephemerally, deleted when session expires.
const sessions = new Map();

const CODE_TTL_MS = 10 * 60 * 1000; // 2 minutes

// ─── Helpers ─────────────────────────────────────────────────────────────────
function createExpiry(code) {
  const timer = setTimeout(() => expireCode(code), CODE_TTL_MS);
  return { timer, expiresAt: Date.now() + CODE_TTL_MS };
}

function expireCode(code) {
  const session = sessions.get(code);
  if (!session) return;

  // Notify all parties the code has expired
  io.to(session.senderSocketId).emit("code-expired", { code });
  session.receivers.forEach((rid) => {
    io.to(rid).emit("code-expired", { code });
  });

  clearTimeout(session.timer);
  sessions.delete(code);
  console.log(`[EXPIRE] Code ${code} expired and cleaned up.`);
}

// ─── Connection handler ───────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ── SENDER: register a new shareable code + encryption key ──────────────────
  // payload: { code, keyHex }  — keyHex is the AES-256 key exported as hex
  socket.on("register-code", ({ code, keyHex }) => {
    if (!code || !keyHex) {
      socket.emit("error-event", { msg: "Missing code or key." });
      return;
    }
    if (sessions.has(code)) {
      socket.emit("error-event", { msg: "Code already exists. Retry." });
      return;
    }

    const { timer, expiresAt } = createExpiry(code);
    sessions.set(code, {
      senderSocketId: socket.id,
      keyHex, // ephemeral — erased with the session
      receivers: new Set(),
      expiresAt,
      timer,
    });

    socket.join(`room:${code}`);
    socket.emit("code-registered", { code, expiresAt });
    console.log(`[REGISTER] Sender ${socket.id} registered code ${code}`);
  });

  // ── SENDER → SERVER: forward WebRTC offer to a specific receiver ───────────
  // payload: { code, receiverId, offer }
  socket.on("send-offer", ({ code, receiverId, offer }) => {
    const session = sessions.get(code);
    if (!session || session.senderSocketId !== socket.id) return;

    io.to(receiverId).emit("receive-offer", {
      code,
      offer,
      senderId: socket.id,
    });
    console.log(`[OFFER] ${socket.id} → ${receiverId} (code: ${code})`);
  });

  // ── RECEIVER: join a session by code ──────────────────────────────────────
  // payload: { code }
  socket.on("join-session", ({ code }) => {
    const session = sessions.get(code);

    if (!session) {
      socket.emit("error-event", { msg: "Code invalid or expired." });
      return;
    }
    if (session.receivers.size >= 5) {
      socket.emit("error-event", { msg: "Session full (max 5 receivers)." });
      return;
    }

    session.receivers.add(socket.id);
    socket.join(`room:${code}`);

    // Tell sender a new receiver joined so they can initiate the offer
    io.to(session.senderSocketId).emit("receiver-joined", {
      receiverId: socket.id,
      code,
      receiverCount: session.receivers.size,
    });

    // Tell receiver: time left + sender ID + the encryption key (auto key delivery)
    socket.emit("session-joined", {
      code,
      expiresAt: session.expiresAt,
      senderId: session.senderSocketId,
      keyHex: session.keyHex, // receiver imports this → no manual key entry needed
    });

    console.log(`[JOIN] Receiver ${socket.id} joined code ${code}`);
  });

  // ── RECEIVER → SERVER: forward answer back to sender ──────────────────────
  // payload: { code, answer, senderId }
  socket.on("send-answer", ({ code, answer, senderId }) => {
    io.to(senderId).emit("receive-answer", {
      answer,
      receiverId: socket.id,
      code,
    });
    console.log(`[ANSWER] ${socket.id} → ${senderId} (code: ${code})`);
  });

  // ── ICE: relay candidates between peers ───────────────────────────────────
  // payload: { code, candidate, targetId }
  socket.on("ice-candidate", ({ code, candidate, targetId }) => {
    if (!targetId) return;
    io.to(targetId).emit("ice-candidate", {
      candidate,
      fromId: socket.id,
      code,
    });
  });

  // ── Cleanup on disconnect ──────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[DISCONNECT] ${socket.id}`);

    for (const [code, session] of sessions.entries()) {
      if (session.senderSocketId === socket.id) {
        // Sender left — expire the whole session
        expireCode(code);
        return;
      }
      if (session.receivers.has(socket.id)) {
        session.receivers.delete(socket.id);
        // Notify sender that a receiver left
        io.to(session.senderSocketId).emit("receiver-left", {
          receiverId: socket.id,
          code,
          receiverCount: session.receivers.size,
        });
      }
    }
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ ok: true, sessions: sessions.size }),
);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));
