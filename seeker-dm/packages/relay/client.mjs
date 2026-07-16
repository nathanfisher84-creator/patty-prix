// @seeker-dm/relay client — high-level send/receive over a relay.
//
// Combines the relay's HTTP endpoints with the crypto core: sending seals a note
// locally and posts the opaque result; receiving pulls the log and scans every
// entry with the local view key. The relay sees only opaque notes and a session
// token — never identities or plaintext.

import { sealNote, scanNote } from "../core/protocol.mjs";

const post = async (fetchFn, url, body) => {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
};

export async function deposit(baseUrl, amountUsd, fetchFn = fetch) {
  return post(fetchFn, baseUrl + "/deposit", { amountUsd });
}

export async function submitNote(baseUrl, sessionToken, note, fetchFn = fetch) {
  return post(fetchFn, baseUrl + "/submit", { sessionToken, note });
}

export async function pullLog(baseUrl, since = 0, fetchFn = fetch) {
  const r = await fetchFn(`${baseUrl}/log?since=${since}`);
  return r.json();
}

// Send a message. `body` is arbitrary text; we wrap it with the sender's own
// meta-address (so the recipient can reply) inside the ENCRYPTED payload — the
// relay and observers never see it. Returns the relay's submit result.
export async function sendMessage(baseUrl, sessionToken, recipientMetaAddr, body, senderMetaAddr, fetchFn = fetch) {
  const envelope = JSON.stringify({ from: senderMetaAddr, body, ts: Date.now() });
  const note = sealNote(recipientMetaAddr, envelope);
  return submitNote(baseUrl, sessionToken, note, fetchFn);
}

// Pull new notes and return the ones addressed to `identity`, decrypted.
// Returns { messages: [{ from, body, ts, stealthAddress }], cursor }.
export async function receiveMessages(baseUrl, identity, since = 0, fetchFn = fetch) {
  const { events, cursor } = await pullLog(baseUrl, since, fetchFn);
  const messages = [];
  for (const e of events) {
    const scan = scanNote(identity, e.note);
    if (!scan.isMine || scan.tampered) continue;
    try {
      const env = JSON.parse(scan.plaintext);
      messages.push({ from: env.from, body: env.body, ts: env.ts, stealthAddress: scan.stealthAddress, seq: e.seq });
    } catch {
      messages.push({ from: null, body: scan.plaintext, ts: null, stealthAddress: scan.stealthAddress, seq: e.seq });
    }
  }
  return { messages, cursor };
}
