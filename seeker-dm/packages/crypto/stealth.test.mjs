// Correctness gate for @seeker-dm/crypto on-curve stealth.
//
// This file is the proof the module is right. It could NOT be run in the repo's
// build sandbox (no network for `npm install @noble/curves`). RUN IT before
// trusting the module:  cd packages/crypto && npm install && npm test
//
// The critical assertion is #4: the recipient can derive a private key that
// actually controls the stealth public point — spend authority is bound.

import {
  createIdentity, metaAddress, sealNote, scanNote, deriveStealthPrivate,
} from "./stealth.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

console.log("\n1. Identity & meta-address");
const alice = createIdentity();
const addr = metaAddress(alice);
check("view & spend public points are 32 bytes", alice.view.pub.length === 32 && alice.spend.pub.length === 32);
check("meta-address is 64 bytes (base64url)", Buffer.from(addr, "base64url").length === 64);

console.log("\n2. Seal → scan round-trip (E2E over on-curve stealth)");
const note = sealNote(addr, "gm — on-curve now");
const got = scanNote(alice, note);
check("recipient detects and decrypts", got.isMine && got.plaintext === "gm — on-curve now");
check("note leaks no plaintext", !JSON.stringify(note).includes("on-curve now"));

console.log("\n3. Only the intended recipient detects it");
const bob = createIdentity();
check("a different identity sees nothing", scanNote(bob, note).isMine === false);

console.log("\n4. SPEND AUTHORITY IS BOUND (the property v1 lacked)");
const d = deriveStealthPrivate(alice, note);
check("recipient derives a private key that controls the stealth point", d.bound === true);
const dBob = deriveStealthPrivate(bob, note);
check("a non-recipient cannot derive a controlling key", dBob.bound === false);

console.log("\n5. Unlinkability — fresh one-time point per note");
const n1 = sealNote(addr, "a");
const n2 = sealNote(addr, "b");
check("two notes → different stealth points", n1.stealthPub !== n2.stealthPub);
check("…and different ephemeral points", n1.ephemeralPub !== n2.ephemeralPub);
check("recipient still recovers both", scanNote(alice, n1).plaintext === "a" && scanNote(alice, n2).plaintext === "b");

console.log("\n6. Tamper-evidence");
const raw = Buffer.from(note.ciphertext, "base64url"); raw[0] ^= 0xff;
const t = scanNote(alice, { ...note, ciphertext: raw.toString("base64url") });
check("tampered ciphertext is caught, not returned as plaintext", t.isMine && t.tampered && t.plaintext === undefined);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
