// Integration test: real HTTP relay on localhost, full send/receive round trip,
// and the privacy invariants. Run: node test/relay.integration.mjs

import { startRelay } from "../packages/relay/server.mjs";
import { mockVerifier } from "../packages/relay/payments.mjs";
import { deposit, sendMessage, receiveMessages, submitNote, pullLog } from "../packages/relay/client.mjs";
import { createIdentity, metaAddress, sealNote, scanNote, exportIdentity, importIdentity } from "../packages/core/protocol.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

// Mock on-chain payments: signature -> credits. "pay-big" buys 100, "pay-2" buys 2.
const relay = await startRelay({
  port: 0,
  feeCredits: 1,
  verifier: mockVerifier({ "pay-big": 100, "pay-2": 2, "pay-dup": 5 }),
});
try {
  console.log("\n1. Health");
  const health = await (await fetch(relay.url + "/health")).json();
  check("relay is up, no notes yet", health.ok && health.notes === 0);

  console.log("\n2. Identity persistence round-trip");
  const alice = createIdentity();
  const bob = createIdentity();
  const aliceAddr = metaAddress(alice), bobAddr = metaAddress(bob);
  const restored = importIdentity(exportIdentity(alice));
  check("export → import preserves the identity", metaAddress(restored) === aliceAddr);

  console.log("\n3. Deposit credit via verified on-chain payment");
  const dep = await deposit(relay.url, "pay-big");
  check("verified payment returns a session token + credits", !!dep.sessionToken && dep.credits === 100);
  const badPay = await deposit(relay.url, "no-such-tx");
  check("unverified payment is refused (402)", !badPay.sessionToken && /not verified/i.test(badPay.error));

  console.log("\n4. Bob messages Alice; Alice receives + decrypts");
  await sendMessage(relay.url, dep.sessionToken, aliceAddr, "gm — saw your .sol, collab?", bobAddr);
  const inbox = await receiveMessages(relay.url, alice, 0);
  check("Alice receives exactly one message", inbox.messages.length === 1);
  check("plaintext decrypts correctly", inbox.messages[0].body === "gm — saw your .sol, collab?");
  check("sender identity is inside the encrypted envelope (for replies)", inbox.messages[0].from === bobAddr);

  console.log("\n5. Alice replies to Bob using the from-address");
  await sendMessage(relay.url, dep.sessionToken, inbox.messages[0].from, "sure, dm me", aliceAddr);
  const bobInbox = await receiveMessages(relay.url, bob, 0);
  check("Bob receives the reply", bobInbox.messages.length === 1 && bobInbox.messages[0].body === "sure, dm me");

  console.log("\n6. A third party cannot read either message");
  const eve = createIdentity();
  const eveInbox = await receiveMessages(relay.url, eve, 0);
  check("Eve, scanning the same log, sees nothing of hers", eveInbox.messages.length === 0);

  console.log("\n7. Unlinkability — two notes to Alice don't cluster");
  await sendMessage(relay.url, dep.sessionToken, aliceAddr, "still around?", bobAddr);
  const log = await pullLog(relay.url, 0);
  const toAlice = log.events.filter(e => scanNote(alice, e.note).isMine);
  check("both of Alice's notes recovered", toAlice.length === 2);
  const stealths = new Set(toAlice.map(e => e.note.stealthAddress));
  const ephs = new Set(toAlice.map(e => e.note.ephemeralPub));
  check("distinct one-time addresses", stealths.size === 2);
  check("distinct ephemeral keys", ephs.size === 2);

  console.log("\n8. Relay is content-blind — no identity anywhere in its state");
  const snap = relay.storage.snapshot();
  const dump = JSON.stringify(snap);
  check("no meta-address (Alice/Bob) in relay state", !dump.includes(aliceAddr) && !dump.includes(bobAddr));
  check("no plaintext in relay state", !dump.includes("collab") && !dump.includes("dm me"));
  check("relay stores only opaque note fields", snap.log.every(e =>
    e.note.ephemeralPub && e.note.stealthAddress && e.note.ciphertext && !("from" in e.note)));

  console.log("\n9. Spam pricing — credit is consumed, blasting runs dry");
  const small = await deposit(relay.url, "pay-2"); // buys exactly 2 credits
  const r1 = await sendMessage(relay.url, small.sessionToken, aliceAddr, "1", bobAddr);
  const r2 = await sendMessage(relay.url, small.sessionToken, aliceAddr, "2", bobAddr);
  const r3 = await sendMessage(relay.url, small.sessionToken, aliceAddr, "3", bobAddr);
  check("first two sends succeed", r1.ok && r2.ok);
  check("third is rejected — out of credit (spam has a real cost)", !r3.ok && /insufficient/i.test(r3.error));

  console.log("\n10. Replay protection — a payment signature is single-use");
  const first = await deposit(relay.url, "pay-dup");
  const replay = await deposit(relay.url, "pay-dup");
  check("first redemption succeeds", first.ok && first.credits === 5);
  check("second redemption of the same signature is refused (409)", !replay.ok && /already redeemed/i.test(replay.error));

  console.log("\n11. Bad input is rejected");
  const badSess = await submitNote(relay.url, "not-a-real-token", sealNote(aliceAddr, "x"));
  check("unknown session token rejected", badSess.error && /session/i.test(badSess.error));
  const badNote = await submitNote(relay.url, dep.sessionToken, { junk: true });
  check("malformed note rejected", badNote.error && /malformed/i.test(badNote.error));

  console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
} finally {
  await relay.stop();
}
process.exit(failures ? 1 : 0);
