// Payment verification tests — the real Solana-RPC verifier against a mocked RPC,
// plus storage replay protection. Run: node test/payments.test.mjs

import { mockVerifier, solanaRpcVerifier } from "../packages/relay/payments.mjs";
import { memoryStorage } from "../packages/relay/storage.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

const TREASURY = "TreasuryPubkey1111111111111111111111111111";
const OTHER = "SomeoneElse11111111111111111111111111111111";

// Build a mocked getTransaction RPC that credits `lamports` to the treasury.
const rpcThatPaid = (lamports, { fail = false, treasuryPresent = true, confirmed = true } = {}) => async () => ({
  json: async () => {
    if (!confirmed) return { result: null };
    const keys = treasuryPresent ? [OTHER, TREASURY] : [OTHER, "Xyz"];
    return {
      result: {
        meta: {
          err: fail ? { InstructionError: [0, "custom"] } : null,
          preBalances: [1_000_000, 5_000_000],
          postBalances: [1_000_000 - lamports, 5_000_000 + (treasuryPresent ? lamports : 0)],
        },
        transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })) } },
      },
    };
  },
});

console.log("\n1. mockVerifier");
const mv = mockVerifier({ good: 10 });
check("known signature → credits", (await mv("good")).credits === 10);
check("unknown signature → not ok", (await mv("bad")).ok === false);

console.log("\n2. solanaRpcVerifier — happy path");
const v = sig => solanaRpcVerifier({
  rpcUrl: "http://rpc", treasury: TREASURY, lamportsPerCredit: 1_000_000, minLamports: 1_000_000,
  fetchFn: rpcThatPaid(3_000_000),
})(sig);
const ok = await v("sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
check("verifies a real transfer to treasury", ok.ok === true);
check("credits = lamports / lamportsPerCredit", ok.credits === 3, `got ${ok.credits}`);

console.log("\n3. solanaRpcVerifier — rejections");
const reject = (opts, lamports = 3_000_000) => solanaRpcVerifier({
  rpcUrl: "http://rpc", treasury: TREASURY, lamportsPerCredit: 1_000_000, minLamports: 1_000_000,
  fetchFn: rpcThatPaid(lamports, opts),
})("sig_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
check("unconfirmed tx rejected", (await reject({ confirmed: false })).ok === false);
check("failed tx rejected", (await reject({ fail: true })).ok === false);
check("treasury-not-in-tx rejected", (await reject({ treasuryPresent: false })).ok === false);
check("below-minimum payment rejected", (await reject({}, 500_000)).ok === false);
check("bad signature type rejected", (await solanaRpcVerifier({
  rpcUrl: "x", treasury: TREASURY, lamportsPerCredit: 1, fetchFn: rpcThatPaid(1) })(123)).ok === false);

console.log("\n4. Replay protection (storage.consumeSignature)");
const store = memoryStorage();
check("first use consumes", (await store.consumeSignature("sig1")) === true);
check("second use of same signature is refused", (await store.consumeSignature("sig1")) === false);

console.log("\n5. File storage round-trips a snapshot");
const { fileStorage } = await import("../packages/relay/storage.mjs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const p = join(tmpdir(), `seeker-relay-${process.pid}.json`);
const fs1 = await fileStorage(p);
await fs1.createSession("tok", 7);
await fs1.appendNote({ ephemeralPub: "e", stealthAddress: "s", nonce: "n", ciphertext: "c" });
const fs2 = await fileStorage(p); // reload from disk
check("session survives reload", (await fs2.getSession("tok"))?.credits === 7);
check("note survives reload", (await fs2.getLog(0, 10)).events.length === 1);
await (await import("node:fs")).promises.unlink(p).catch(() => {});

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
