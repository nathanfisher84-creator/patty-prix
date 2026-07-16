// @seeker-dm/relay — content-blind store-and-forward relay.
//
// Knows NOTHING about message content or identities. Stores opaque sealed notes
// in an append-only log (via a pluggable storage adapter) and serves them by
// cursor; recipients scan locally with their view key. Spam is priced by a
// per-note credit fee. Credit is bought by a REAL on-chain payment: /deposit
// takes a confirmed transaction signature, a verifier confirms lamports landed
// in the treasury, the signature is single-use (replay-protected), and only
// then is a session credited.
//
// Production wiring: pass a `solanaRpcVerifier` (payments.mjs) and a durable
// `storage` adapter (storage.mjs). Defaults are dev-only (mock verifier that
// credits nothing, in-memory storage). See ../../SECURITY.md.

import http from "node:http";
import crypto from "node:crypto";
import { memoryStorage } from "./storage.mjs";
import { mockVerifier } from "./payments.mjs";

const MAX_BODY = 256 * 1024;

export function createRelay({
  storage = memoryStorage(),
  verifier = mockVerifier(),            // dev default credits nothing — configure a real one
  feeCredits = 1,                       // cost to submit one note
  submitRatePerMin = 60,                // per-session token-bucket refill
  submitBurst = 20,                     // per-session bucket capacity
  now = () => Date.now(),
} = {}) {
  const buckets = new Map(); // token -> { tokens, ts }

  const allow = token => {
    const cap = submitBurst, refill = submitRatePerMin / 60000; // tokens/ms
    const b = buckets.get(token) || { tokens: cap, ts: now() };
    const t = now();
    b.tokens = Math.min(cap, b.tokens + (t - b.ts) * refill);
    b.ts = t;
    if (b.tokens < 1) { buckets.set(token, b); return false; }
    b.tokens -= 1; buckets.set(token, b); return true;
  };

  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise((resolve, reject) => {
    let raw = "", big = false;
    req.on("data", c => { raw += c; if (raw.length > MAX_BODY) { big = true; req.destroy(); } });
    req.on("end", () => (big ? reject(new Error("body too large")) : resolve(raw ? JSON.parse(raw) : {})));
    req.on("error", reject);
  });

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, "http://relay");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        const { total } = await storage.getLog(0, 0);
        return json(res, 200, { ok: true, feeCredits, notes: total });
      }

      // Buy credit with proof of an on-chain payment. The verifier confirms the
      // transaction; the signature is consumed once (replay protection).
      if (req.method === "POST" && path === "/deposit") {
        const { signature } = await readBody(req);
        if (!signature) return json(res, 400, { error: "signature required (proof of on-chain payment)" });
        const v = await verifier(signature);
        if (!v.ok) return json(res, 402, { error: "payment not verified", reason: v.reason });
        if (!(await storage.consumeSignature(signature))) return json(res, 409, { error: "payment already redeemed" });
        const token = crypto.randomBytes(24).toString("base64url");
        await storage.createSession(token, v.credits);
        return json(res, 200, { ok: true, sessionToken: token, credits: v.credits });
      }

      // Submit a sealed note; pay the per-note fee from the session's credit.
      if (req.method === "POST" && path === "/submit") {
        const { sessionToken, note } = await readBody(req);
        const sess = sessionToken ? await storage.getSession(sessionToken) : null;
        if (!sess) return json(res, 401, { error: "unknown or missing session token" });
        if (!validNote(note)) return json(res, 400, { error: "malformed note" });
        if (!allow(sessionToken)) return json(res, 429, { error: "rate limited — slow down" });
        if (sess.credits < feeCredits) return json(res, 402, { error: "insufficient credit", credits: sess.credits });
        await storage.setCredits(sessionToken, sess.credits - feeCredits);
        const seq = await storage.appendNote(note);
        return json(res, 200, { ok: true, seq, credits: sess.credits - feeCredits });
      }

      // Pull the append-only log after a cursor; recipients scan locally.
      if (req.method === "GET" && path === "/log") {
        const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0);
        const limit = Math.min(1000, parseInt(url.searchParams.get("limit") || "500", 10) || 500);
        const { events, cursor, total } = await storage.getLog(since, limit);
        return json(res, 200, { events, cursor, more: total > cursor });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  };

  return { handler, storage };
}

function validNote(n) {
  return n && typeof n === "object" &&
    typeof n.ephemeralPub === "string" &&
    (typeof n.stealthAddress === "string" || typeof n.stealthPub === "string") &&
    typeof n.nonce === "string" && typeof n.ciphertext === "string" &&
    JSON.stringify(n).length <= MAX_BODY;
}

export async function startRelay(opts = {}) {
  const { handler, storage } = createRelay(opts);
  const server = http.createServer(handler);
  const port = opts.port ?? 0;
  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      resolve({ server, storage, url: `http://127.0.0.1:${p}`, stop: () => new Promise(r => server.close(r)) });
    });
  });
}

if (process.argv[1] && import.meta.url === (await import("url")).pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  // Configure a real verifier + durable storage via env for production; the
  // bare default credits nothing (deposits will 402) and stores in memory.
  const { url } = await startRelay({ port });
  console.log(`seeker-dm relay on ${url} — DEV MODE (no payment verifier / in-memory). Configure payments.mjs + storage.mjs for production.`);
}
