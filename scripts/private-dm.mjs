// Patty Prix — private-DM core (paper crypto demo).
//
// Proves the confidentiality thesis for a Solana-native messenger: you can let
// a stranger message you, gated by a refundable anti-spam stake, WITHOUT ever
// writing a "sender ↔ recipient" link anywhere an observer (or a chain-analysis
// tool like the whale tracker in this repo) could read. Four properties:
//
//   1. DEDICATED IDENTITY   your messaging keys are NOT your funded wallet — a
//                           separate keypair with no financial history to trace.
//   2. STEALTH ADDRESSES    every message goes to a fresh one-time address; two
//                           messages to the same person can't be clustered, and
//                           even someone holding your public address can't tell
//                           a note is yours. Only your view key can detect it.
//   3. E2E ENCRYPTION       message bodies are sealed with a key derived from an
//                           X25519 ECDH handshake; only the recipient decrypts.
//   4. GRAPH-PRIVATE CREDIT the stake that gates a stranger's DM is accounted
//                           against the one-time address, never your identity.
//
// It's a calculator/simulator: no mempool, RPC, wallet, or real funds. Uses only
// Node's built-in `crypto` (X25519 ECDH + HKDF + AES-256-GCM), so the repo stays
// dependency-free.
//
// What's cryptographically ENFORCED here: E2E encryption, tamper-evidence (GCM),
// recipient-only detection (view key), and unlinkability of one-time addresses
// (fresh ephemeral key per note). What's MODELED, not on-curve: binding *spend
// authority* to a stealth address — a production Solana build derives it as
// P = P_spend + H(s)·G with on-curve point addition (an ed25519 library); here
// the one-time address is treated as recipient-controlled. The credit ledger is
// an off-chain model, not a deployed program.
//
// Usage:
//   node scripts/private-dm.mjs            # walk through a full Alice/Bob demo
//   node scripts/private-dm.mjs --demo     # same

import crypto from "node:crypto";
import { pathToFileURL } from "url";

/* ================================================================
   Low-level primitives (X25519 ECDH, HKDF, AES-256-GCM)
   ================================================================ */

const b64u = b => Buffer.from(b).toString("base64url");
const unb64u = s => Buffer.from(s, "base64url");

function genKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    pub: unb64u(publicKey.export({ format: "jwk" }).x),
    priv: unb64u(privateKey.export({ format: "jwk" }).d),
  };
}
function pubKeyObj(pubRaw) {
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64u(pubRaw) }, format: "jwk" });
}
function privKeyObj(privRaw, pubRaw) {
  return crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: b64u(pubRaw), d: b64u(privRaw) }, format: "jwk" });
}
// Diffie–Hellman shared secret between my keypair and a peer's public key.
function ecdh(myPriv, myPub, peerPub) {
  return crypto.diffieHellman({ privateKey: privKeyObj(myPriv, myPub), publicKey: pubKeyObj(peerPub) });
}
function hkdf(shared, info, len = 32) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(info), len));
}

/* ================================================================
   Identity — a DEDICATED messaging keypair, not your funded wallet
   ================================================================ */

// Dual-key stealth identity: a view key (scans for incoming notes) and a spend
// key (would authorize moving anything received). Publishing the meta-address
// lets anyone message you; it reveals nothing about your wallet or your traffic.
export function createIdentity() {
  return { view: genKeypair(), spend: genKeypair() };
}
export function metaAddress(id) {
  return b64u(Buffer.concat([id.view.pub, id.spend.pub]));
}
export function parseMetaAddress(s) {
  const raw = unb64u(s);
  if (raw.length !== 64) throw new Error("bad meta-address");
  return { viewPub: raw.subarray(0, 32), spendPub: raw.subarray(32, 64) };
}

/* ================================================================
   Seal — sender builds a note bound to a fresh one-time address
   ================================================================ */

// The note is what would go to the relay/chain. It carries a per-message
// ephemeral public key, a one-time stealth address, and the ciphertext — and
// NOTHING that identifies the recipient. `rng` is injectable for tests.
export function sealNote(metaAddr, plaintext, rng = crypto.randomBytes) {
  const { viewPub, spendPub } = parseMetaAddress(metaAddr);
  const eph = genKeypair();                             // fresh per note → unlinkable
  const shared = ecdh(eph.priv, eph.pub, viewPub);
  const stealth = crypto.createHash("sha256").update(hkdf(shared, "stealth")).update(spendPub).digest();
  const key = hkdf(shared, "encrypt", 32);
  const iv = rng(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return {
    ephemeralPub: b64u(eph.pub),
    stealthAddress: b64u(stealth),
    nonce: b64u(iv),
    ciphertext: b64u(Buffer.concat([ct, cipher.getAuthTag()])),
  };
}

/* ================================================================
   Scan — recipient checks a note with their VIEW key only
   ================================================================ */

// Only the holder of the view private key can recompute the shared secret and
// therefore the stealth address. Someone who merely knows your public
// meta-address cannot: they have viewPub/spendPub but no way to derive `shared`.
export function scanNote(identity, note) {
  const shared = ecdh(identity.view.priv, identity.view.pub, unb64u(note.ephemeralPub));
  const expected = crypto.createHash("sha256").update(hkdf(shared, "stealth")).update(identity.spend.pub).digest();
  if (b64u(expected) !== note.stealthAddress) return { isMine: false };

  const key = hkdf(shared, "encrypt", 32);
  const data = unb64u(note.ciphertext);
  const ct = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, unb64u(note.nonce));
  dec.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
    return { isMine: true, plaintext, stealthAddress: note.stealthAddress };
  } catch {
    return { isMine: true, tampered: true, stealthAddress: note.stealthAddress };
  }
}

// What a chain-analysis observer sees — deliberately, no recipient or sender.
export function observe(note) {
  return { ephemeralPub: note.ephemeralPub, stealthAddress: note.stealthAddress, ciphertextBytes: unb64u(note.ciphertext).length };
}

/* ================================================================
   Credit gate — anti-spam stake, keyed to the one-time address
   ================================================================ */

// A stranger must post a refundable stake to land in your inbox. Legit senders
// get it back on accept; spammers get it slashed. Crucially the pending map is
// keyed by the one-time stealthAddress, never by your identity — so the
// anti-spam accounting itself leaks no social graph.
export function createInbox({ minStakeUsd = 1 } = {}) {
  return { minStakeUsd, pending: new Map(), accepted: [], slashedUsd: 0 };
}
export function deliver(inbox, note, stakeUsd) {
  if (stakeUsd < inbox.minStakeUsd) return { accepted: false, reason: `stake $${stakeUsd} below inbox minimum $${inbox.minStakeUsd}` };
  inbox.pending.set(note.stealthAddress, { note, stakeUsd });
  return { accepted: true };
}
// Recipient scans everything pending and decides per message.
export function triage(inbox, identity) {
  const out = [];
  for (const [addr, { note, stakeUsd }] of inbox.pending) {
    const scan = scanNote(identity, note);
    out.push({ stealthAddress: addr, isMine: scan.isMine, tampered: !!scan.tampered, stakeUsd, plaintext: scan.plaintext });
  }
  return out;
}
export function accept(inbox, stealthAddress) {
  const e = inbox.pending.get(stealthAddress);
  if (!e) return { refundedUsd: 0 };
  inbox.pending.delete(stealthAddress);
  inbox.accepted.push(e);
  return { refundedUsd: e.stakeUsd };
}
export function reject(inbox, stealthAddress) {
  const e = inbox.pending.get(stealthAddress);
  if (!e) return { slashedUsd: 0 };
  inbox.pending.delete(stealthAddress);
  inbox.slashedUsd += e.stakeUsd;
  return { slashedUsd: e.stakeUsd };
}

/* ================================================================
   Demo
   ================================================================ */

function short(s) { return s.slice(0, 10) + "…" + s.slice(-6); }

export function runDemo(log = console.log) {
  log("🕵️  PRIVATE DM — paper crypto demo (nothing executes on-chain)\n");

  // Alice publishes a dedicated messaging identity — not her wallet.
  const alice = createIdentity();
  const aliceAddr = metaAddress(alice);
  log("Alice creates a DEDICATED messaging identity (not her funded wallet) and");
  log(`publishes her meta-address:\n  ${short(aliceAddr)}\n`);

  // A stranger (Bob) messages her, posting a refundable stake.
  const inbox = createInbox({ minStakeUsd: 1 });
  const bobNote = sealNote(aliceAddr, "gm — saw your .sol, want to collab?");
  deliver(inbox, bobNote, 2);
  log("A stranger seals a note to Alice and posts a $2 refundable stake.");
  log("What the RELAY / an on-chain observer sees:");
  log("  " + JSON.stringify(observe(bobNote)));
  log("  → a one-time address + an ephemeral key. No 'to: Alice'. Unlinkable.\n");

  // A second note from the same stranger — proves unlinkability.
  const bobNote2 = sealNote(aliceAddr, "still around?");
  log("The same stranger sends a SECOND note. Observer sees two unrelated");
  log(`one-time addresses:\n  ${short(bobNote.stealthAddress)}\n  ${short(bobNote2.stealthAddress)}`);
  log("  → nothing clusters them to each other or to Alice.\n");

  // A spammer blasts everyone, cheaply — but the stake gate makes it costly.
  const spam = sealNote(aliceAddr, "🚀 FREE AIRDROP claim now 🚀");
  deliver(inbox, spam, 1);
  deliver(inbox, bobNote2, 2);

  // Alice scans with her VIEW key — only she can tell these are hers.
  log("Alice scans her inbox with her VIEW key (no one else can):");
  for (const m of triage(inbox, alice)) {
    log(`  • ${short(m.stealthAddress)}  stake $${m.stakeUsd}  → "${m.plaintext}"`);
  }
  log("");

  // She accepts the real ones (stake refunded) and slashes the spam.
  accept(inbox, bobNote.stealthAddress);
  accept(inbox, bobNote2.stealthAddress);
  const slashed = reject(inbox, spam.stealthAddress);
  log(`Alice accepts the genuine notes (stakes refunded) and slashes the spam ($${slashed.slashedUsd} forfeited).`);
  log("A spammer blasting thousands of inboxes now pays a real per-message cost —");
  log("trivial for one human, ruinous at spam scale.\n");

  // Confidentiality receipts.
  const ledger = JSON.stringify([...inbox.pending.entries(), ...inbox.accepted]);
  log("Confidentiality check — does any record contain Alice's identity?");
  log(`  inbox keyed by identity?   ${ledger.includes(aliceAddr) ? "❌ yes" : "✅ no, only one-time addresses"}`);
  log(`  observer can link 2 notes? ${bobNote.stealthAddress === bobNote2.stealthAddress ? "❌ yes" : "✅ no, distinct one-time addresses"}`);
  const outsider = createIdentity();
  log(`  outsider can read a note?  ${scanNote(outsider, bobNote).isMine ? "❌ yes" : "✅ no, not their view key"}\n`);

  log("Enforced here: E2E encryption, tamper-evidence, view-key-only detection,");
  log("one-time-address unlinkability. Modeled (not on-curve): binding spend");
  log("authority to the stealth address, and the off-chain credit ledger.");
  log("This is the gap the 2026 Solana privacy primitives (stealth addresses +");
  log("confidential transfers) are built to close — and what SolChat/Dialect,");
  log("which encrypt content but publish the graph, do not.");
}

export function main(argv = process.argv.slice(2)) {
  runDemo();
  void argv;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
