/**
 * socket.js  –  Singleton Socket.IO client
 * Lazy-connect so tests that don't need the socket don't trigger a connection.
 */
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:5000";

export const socket = io(SOCKET_URL, {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  transports: ["polling", "websocket"], // polling first, websocket upgrade
});

socket.on("connect", () => console.log("[Socket] Connected:", socket.id));
socket.on("disconnect", (reason) => console.warn("[Socket] Disconnected:", reason));
socket.on("connect_error", (err) => console.error("[Socket] Error:", err.message));
