// @seeker-dm/relay — content-blind store-and-forward relay.
//
// Deliberately knows NOTHING about message content or identities. It stores
// opaque sealed notes in an append-only log and serves them by cursor. It has
// no import of @seeker-dm/core and no way to decrypt, derive a stealth address,
// or learn who is talking to whom — recipients scan the log locally with their
// view key. Spam is priced by a per-note credit fee: senders deposit credit and
// each note costs a small fee, so blasting is expensive; reading is free.
//
// v1 models the credit deposit in memory. The production relay verifies an
// actual on-chain payment before crediting a session (see ../../SECURITY.md →
// "Credit / deposit" and ARCHITECTURE.md). No persistence here yet either —
// swap the in-memory maps for a store before real deployment.

import http from "node:http";
import crypto from "node:crypto";

const MAX_BODY = 256 * 1024; // reject oversized note payloads

export function createRelay({ feeUsd = 0.01 } = {}) {
  const state = {
    feeUsd,
    sessions: new Map(), // opaque token → { balanceUsd }
    log: [],             // append-only: { seq, note }
    seq: 0,
  };

  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const readBody = req =>
    new Promise((resolve, reject) => {
      let raw = "", tooBig = false;
      req.on("data", c => {
        raw += c;
        if (raw.length > MAX_BODY) { tooBig = true; req.destroy(); }
      });
      req.on("end", () => (tooBig ? reject(new Error("body too large")) : resolve(raw ? JSON.parse(raw) : {})));
      req.on("error", reject);
    });

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, "http://relay");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, feeUsd: state.feeUsd, notes: state.log.length, sessions: state.sessions.size });
      }

      // Deposit credit → opaque session token. v1 models the deposit; the
      // production relay requires proof of an on-chain payment first.
      if (req.method === "POST" && path === "/deposit") {
        const { amountUsd } = await readBody(req);
        const amt = Number(amountUsd);
        if (!(amt > 0)) return json(res, 400, { error: "amountUsd must be > 0" });
        const token = crypto.randomBytes(24).toString("base64url");
        state.sessions.set(token, { balanceUsd: amt });
        return json(res, 200, { ok: true, sessionToken: token, balanceUsd: amt });
      }

      // Submit a sealed note, paying the fee from the session balance. The relay
      // stores the note opaquely — it cannot read it or tell who it's for.
      if (req.method === "POST" && path === "/submit") {
        const { sessionToken, note } = await readBody(req);
        const sess = state.sessions.get(sessionToken);
        if (!sess) return json(res, 401, { error: "unknown or missing session token" });
        if (!validNote(note)) return json(res, 400, { error: "malformed note" });
        if (sess.balanceUsd < state.feeUsd) return json(res, 402, { error: "insufficient credit", balanceUsd: sess.balanceUsd });
        sess.balanceUsd = round4(sess.balanceUsd - state.feeUsd);
        const entry = { seq: ++state.seq, note };
        state.log.push(entry);
        return json(res, 200, { ok: true, seq: entry.seq, balanceUsd: sess.balanceUsd });
      }

      // Pull the append-only log after a cursor. Recipients download and scan
      // locally; the relay never learns which notes anyone cares about.
      if (req.method === "GET" && path === "/log") {
        const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0);
        const limit = Math.min(1000, parseInt(url.searchParams.get("limit") || "500", 10) || 500);
        const events = state.log.filter(e => e.seq > since).slice(0, limit);
        const cursor = events.length ? events[events.length - 1].seq : since;
        return json(res, 200, { events, cursor, more: state.seq > cursor });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  };

  return { handler, state };
}

// Shape check only — the relay cannot (and must not) interpret note contents.
function validNote(n) {
  return n && typeof n === "object" &&
    typeof n.ephemeralPub === "string" && typeof n.stealthAddress === "string" &&
    typeof n.nonce === "string" && typeof n.ciphertext === "string" &&
    JSON.stringify(n).length <= MAX_BODY;
}
function round4(n) { return Math.round(n * 1e4) / 1e4; }

// Start an HTTP server. Returns { server, url, stop, state }.
export function startRelay({ port = 0, feeUsd } = {}) {
  const { handler, state } = createRelay({ feeUsd });
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      resolve({ server, state, url: `http://127.0.0.1:${p}`, stop: () => new Promise(r => server.close(r)) });
    });
  });
}

if (process.argv[1] && import.meta.url === (await import("url")).pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  const feeUsd = process.env.FEE_USD ? Number(process.env.FEE_USD) : undefined;
  const { url } = await startRelay({ port, feeUsd });
  console.log(`seeker-dm relay listening on ${url}  (content-blind; in-memory — not for production as-is)`);
}
