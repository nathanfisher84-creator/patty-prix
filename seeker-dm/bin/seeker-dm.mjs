#!/usr/bin/env node
// seeker-dm reference CLI — a runnable end-to-end client over the real packages.
//
//   node bin/seeker-dm.mjs demo       # full stack in one process: relay +
//                                      verified payment + name resolution +
//                                      stealth messaging + conversation threads
//   node bin/seeker-dm.mjs identity   # generate a dedicated identity + address
//
// The `demo` is a working proof that the whole engine composes — not a mock of
// the flow but the actual protocol core, relay, payments, names, and
// conversation store wired together.

import { startRelay } from "../packages/relay/server.mjs";
import { mockVerifier } from "../packages/relay/payments.mjs";
import { deposit, sendMessage, receiveMessages } from "../packages/relay/client.mjs";
import { createIdentity, metaAddress } from "../packages/core/protocol.mjs";
import { registryResolver } from "../packages/core/names.mjs";
import { createConversationStore } from "../packages/core/conversations.mjs";

const log = (...a) => console.log(...a);
const short = s => s.slice(0, 8) + "…" + s.slice(-4);

async function demo() {
  // A relay whose verifier credits a known "payment" (stands in for an on-chain
  // deposit tx). In production this is a solanaRpcVerifier + a durable store.
  const relay = await startRelay({ port: 0, feeCredits: 1, verifier: mockVerifier({ "deposit-tx-alice": 50 }) });
  log("relay up:", relay.url, "\n");

  try {
    // Two users create dedicated messaging identities (not their wallets).
    const alice = createIdentity(), bob = createIdentity();
    const aliceAddr = metaAddress(alice), bobAddr = metaAddress(bob);

    // Opt-in directory: Alice publishes her address under alice.sol.
    const names = registryResolver({ "alice.sol": aliceAddr });
    log("alice.sol →", short(aliceAddr));
    log("bob        ", short(bobAddr), "(unlisted — reachable only if he shares his address)\n");

    // Bob buys relay credit with a verified payment, resolves alice.sol, messages her.
    const { sessionToken } = await deposit(relay.url, "deposit-tx-alice");
    const target = await names.resolve("alice.sol");
    await sendMessage(relay.url, sessionToken, target, "gm — found you via alice.sol", bobAddr);
    await sendMessage(relay.url, sessionToken, target, "wanna collab on the Seeker app?", bobAddr);
    log("bob → alice: 2 messages sent (paid credit, resolved by name)\n");

    // Alice pulls the log, decrypts hers, and threads them.
    const store = createConversationStore();
    let cursor = 0;
    const first = await receiveMessages(relay.url, alice, cursor); cursor = first.cursor;
    first.messages.forEach(m => store.addIncoming(m));

    // Alice replies to Bob (the from-address rode inside the encrypted envelope).
    const peer = store.list()[0].peer;
    await sendMessage(relay.url, sessionToken, peer, "yes — let's build it", aliceAddr);
    store.addOutgoing(peer, "yes — let's build it", Date.now());

    // Bob receives the reply.
    const bobStore = createConversationStore();
    (await receiveMessages(relay.url, bob, 0)).messages.forEach(m => bobStore.addIncoming(m));

    log("── Alice's conversation with Bob ──");
    for (const m of store.thread(peer)) log(`  ${m.dir === "out" ? "→" : "←"} ${m.body}`);
    log("\n── Bob's inbox ──");
    for (const t of bobStore.list()) log(`  from ${short(t.peer)}: "${t.preview}"`);

    // Confirm the relay never saw an identity.
    const dump = JSON.stringify(relay.storage.snapshot());
    log("\nrelay leaked an identity?", dump.includes(aliceAddr) || dump.includes(bobAddr) ? "❌ YES" : "✅ no — content-blind");
  } finally {
    await relay.stop();
  }
}

function identity() {
  const id = createIdentity();
  log("meta-address (share this):\n  " + metaAddress(id));
  log("\nStore the full identity securely (Seed Vault / OS keystore) — never plaintext.");
}

const cmd = process.argv[2];
if (cmd === "demo") await demo();
else if (cmd === "identity") identity();
else { log("usage: seeker-dm <demo|identity>"); process.exit(1); }
