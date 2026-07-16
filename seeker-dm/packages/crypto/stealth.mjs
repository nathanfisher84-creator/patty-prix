// @seeker-dm/crypto — on-curve ed25519 stealth addresses (dual-key scheme).
//
// This HARDENS the v1 protocol: the stealth address is now a real ed25519 point
// P = S + H(shared)·G whose private key p = s + H(shared) is derivable ONLY by
// the recipient — binding spend authority, not just detectability. It is the
// production replacement for the hash-commitment stealth in @seeker-dm/core.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ VERIFICATION STATUS: UNVERIFIED IN THIS REPO'S SANDBOX.                    │
// │ The point arithmetic needs @noble/curves, which requires `npm install`;    │
// │ the CI/build sandbox has no network, so THIS MODULE WAS NOT EXECUTED here.  │
// │ Before trusting it: run `npm install && npm test` in packages/crypto on a   │
// │ networked machine. The test (stealth.test.mjs) is the correctness gate —    │
// │ it fails loudly if the scheme or the noble API binding is wrong.            │
// │ Written against @noble/curves ^1.x; if the import fails, the point API was  │
// │ renamed between versions — adjust `Pt`, `BASE`, `ORDER`, `toRaw`, `fromRaw`.│
// │ This module is the #1 item for the security audit (SECURITY.md §1).         │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Only the curve point ops come from noble; hashing, HKDF, and AES-256-GCM use
// Node's built-in crypto (same primitives the tested core uses).

import { ed25519 } from "@noble/curves/ed25519";
import crypto from "node:crypto";

// ---- noble binding shims (adjust here if the noble version renamed things) ----
const Pt = ed25519.Point ?? ed25519.ExtendedPoint;     // point class
const BASE = Pt.BASE;                                    // generator G
const ORDER = (Pt.Fn?.ORDER) ?? ed25519.CURVE?.n ?? Pt.CURVE?.n; // scalar field order ℓ
const toRaw = p => p.toRawBytes();                       // point → 32 bytes
const fromRaw = b => Pt.fromHex(Buffer.from(b).toString("hex")); // bytes → point

if (!Pt || !BASE || typeof ORDER !== "bigint") {
  throw new Error("@noble/curves binding failed — check the installed version and update the shims at the top of stealth.mjs");
}

// ---- scalar / hashing helpers (Node built-ins) ----
const bytesToScalar = buf => BigInt("0x" + Buffer.from(buf).toString("hex")) % ORDER;
function randScalar() {
  // 64 random bytes reduced mod ℓ → negligible modulo bias; retry if 0.
  let s = bytesToScalar(crypto.randomBytes(64));
  while (s === 0n) s = bytesToScalar(crypto.randomBytes(64));
  return s;
}
// Domain-separated hash of the shared-secret point to a scalar.
const hashToScalar = sharedBytes =>
  bytesToScalar(crypto.createHash("sha512").update("seeker-dm/stealth-scalar").update(sharedBytes).digest());
const hkdf = (ikm, info, len = 32) =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info), len));
const b64u = b => Buffer.from(b).toString("base64url");
const unb64u = s => Buffer.from(s, "base64url");

/* ---------- identity ---------- */

// Dual-key stealth identity. spend = authority over received funds/notes;
// view = scanning. Private keys are bigint scalars; publics are 32-byte points.
export function createIdentity() {
  const spendScalar = randScalar(), viewScalar = randScalar();
  return {
    spend: { scalar: spendScalar, pub: toRaw(BASE.multiply(spendScalar)) },
    view: { scalar: viewScalar, pub: toRaw(BASE.multiply(viewScalar)) },
  };
}
export function metaAddress(id) {
  return b64u(Buffer.concat([Buffer.from(id.view.pub), Buffer.from(id.spend.pub)]));
}
export function parseMetaAddress(s) {
  const raw = unb64u(s);
  if (raw.length !== 64) throw new Error("bad meta-address");
  return { viewPub: raw.subarray(0, 32), spendPub: raw.subarray(32, 64) };
}

/* ---------- seal (sender) ---------- */

export function sealNote(recipientMetaAddr, plaintext) {
  const { viewPub, spendPub } = parseMetaAddress(recipientMetaAddr);
  const r = randScalar();
  const R = BASE.multiply(r);                       // ephemeral pub
  const shared = fromRaw(viewPub).multiply(r);      // r·V  (ECDH point)
  const sharedBytes = toRaw(shared);
  const k = hashToScalar(sharedBytes);
  const P = fromRaw(spendPub).add(BASE.multiply(k)); // stealth pub = S + k·G  (spendable)
  const key = hkdf(sharedBytes, "seeker-dm/encrypt", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return {
    v: 2,
    viewTag: hkdf(sharedBytes, "seeker-dm/viewtag", 1).toString("hex"),
    ephemeralPub: b64u(toRaw(R)),
    stealthPub: b64u(toRaw(P)),
    nonce: b64u(iv),
    ciphertext: b64u(Buffer.concat([ct, cipher.getAuthTag()])),
  };
}

/* ---------- scan (recipient) ---------- */

// Detect + decrypt with the VIEW key. Returns { isMine, plaintext?, tampered?,
// stealthPub? }. The shared point is the same on both sides: v·R == r·V.
export function scanNote(identity, note) {
  const shared = fromRaw(unb64u(note.ephemeralPub)).multiply(identity.view.scalar);
  const sharedBytes = toRaw(shared);
  if (note.viewTag && hkdf(sharedBytes, "seeker-dm/viewtag", 1).toString("hex") !== note.viewTag) return { isMine: false };

  const k = hashToScalar(sharedBytes);
  const P = fromRaw(identity.spend.pub).add(BASE.multiply(k));
  if (b64u(toRaw(P)) !== note.stealthPub) return { isMine: false };

  const key = hkdf(sharedBytes, "seeker-dm/encrypt", 32);
  const data = unb64u(note.ciphertext);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, unb64u(note.nonce));
  dec.setAuthTag(data.subarray(data.length - 16));
  try {
    const plaintext = Buffer.concat([dec.update(data.subarray(0, data.length - 16)), dec.final()]).toString("utf8");
    return { isMine: true, plaintext, stealthPub: note.stealthPub };
  } catch {
    return { isMine: true, tampered: true, stealthPub: note.stealthPub };
  }
}

// Recipient-only: derive the private key for a detected stealth address. This is
// the property the v1 core lacked — proof of spend authority. p = (s + k) mod ℓ,
// and G·p must equal the note's stealth public key.
export function deriveStealthPrivate(identity, note) {
  const shared = fromRaw(unb64u(note.ephemeralPub)).multiply(identity.view.scalar);
  const k = hashToScalar(toRaw(shared));
  const p = (identity.spend.scalar + k) % ORDER;
  const bound = b64u(toRaw(BASE.multiply(p))) === note.stealthPub;
  return { stealthPrivate: p, bound }; // `bound` MUST be true for a genuine note
}
