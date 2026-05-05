/**
 * crypto.js  –  AES-GCM 256 End-to-End Encryption helpers
 * All operations are async and use the native Web Crypto API.
 */

const ALGO = { name: "AES-GCM", length: 256 };

// ─── Key Management ───────────────────────────────────────────────────────────

/** Generate a fresh AES-GCM 256 key */
export async function generateKey() {
  return crypto.subtle.generateKey(ALGO, true, ["encrypt", "decrypt"]);
}

/**
 * Export a CryptoKey to a plain hex string (safe to embed in QR / URL).
 * @param {CryptoKey} key
 * @returns {Promise<string>} hex string
 */
export async function exportKeyHex(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return Array.from(new Uint8Array(raw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Import a hex string back into a usable CryptoKey.
 * @param {string} hex
 * @returns {Promise<CryptoKey>}
 */
export async function importKeyHex(hex) {
  const bytes = new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey("raw", bytes, ALGO, false, ["encrypt", "decrypt"]);
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt an ArrayBuffer.
 * Returns a new ArrayBuffer: [12-byte IV | ciphertext].
 * @param {CryptoKey} key
 * @param {ArrayBuffer} data
 * @returns {Promise<ArrayBuffer>}
 */
export async function encrypt(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);

  // Prepend IV so the receiver can extract it
  const result = new Uint8Array(iv.byteLength + cipher.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(cipher), iv.byteLength);
  return result.buffer;
}

/**
 * Decrypt an ArrayBuffer that was produced by `encrypt()`.
 * @param {CryptoKey} key
 * @param {ArrayBuffer} data [IV | ciphertext]
 * @returns {Promise<ArrayBuffer>}
 */
export async function decrypt(key, data) {
  const iv = new Uint8Array(data, 0, 12);
  const cipher = new Uint8Array(data, 12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
}

/**
 * Encrypt a plain JS string.
 * @param {CryptoKey} key
 * @param {string} text
 * @returns {Promise<ArrayBuffer>}
 */
export async function encryptText(key, text) {
  const encoded = new TextEncoder().encode(text);
  return encrypt(key, encoded);
}

/**
 * Decrypt an ArrayBuffer that was produced by `encryptText()`.
 * @param {CryptoKey} key
 * @param {ArrayBuffer} data
 * @returns {Promise<string>}
 */
export async function decryptText(key, data) {
  const plain = await decrypt(key, data);
  return new TextDecoder().decode(plain);
}
