// Tests for name resolution and the conversation store.
// Run: node test/core.test.mjs

import { createIdentity, metaAddress } from "../packages/core/protocol.mjs";
import { registryResolver, snsResolver, parseMetaFromRecord, isValidMetaAddress } from "../packages/core/names.mjs";
import { createConversationStore } from "../packages/core/conversations.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

const alice = metaAddress(createIdentity());
const bob = metaAddress(createIdentity());

console.log("\n1. Meta-address validation");
check("accepts a real meta-address", isValidMetaAddress(alice));
check("rejects junk", !isValidMetaAddress("not-an-address"));
check("parseMetaFromRecord trims + validates", parseMetaFromRecord("  " + alice + "\n") === alice);
check("parseMetaFromRecord rejects bad content", parseMetaFromRecord("hello") === null);
check("parseMetaFromRecord handles bytes", parseMetaFromRecord(Buffer.from(alice, "utf8")) === alice);

console.log("\n2. Registry resolver (dev)");
const reg = registryResolver({ "patty.sol": alice });
check("resolves a known name", (await reg.resolve("patty.sol")) === alice);
check("case-insensitive", (await reg.resolve("PATTY.SOL")) === alice);
check("unknown name → null", (await reg.resolve("nobody.sol")) === null);

console.log("\n3. SNS resolver (RPC + parse path, mocked)");
const mockRpc = (accountData) => async () => ({
  json: async () => ({ result: { value: accountData ? { data: [Buffer.from(accountData, "utf8").toString("base64"), "base64"] } : null } }),
});
const sns = data => snsResolver({
  rpcUrl: "http://rpc",
  deriveRecordAccount: async () => "RecordAccount1111111111111111111111111111111",
  fetchFn: mockRpc(data),
});
check("resolves meta-address from an SNS record", (await sns(alice).resolve("patty.sol")) === alice);
check("empty record → null", (await sns(null).resolve("patty.sol")) === null);
check("garbage record → null", (await sns("junk").resolve("patty.sol")) === null);
let threw = false; try { snsResolver({ rpcUrl: "x" }); } catch { threw = true; }
check("misconfigured resolver throws early", threw);

console.log("\n4. Conversation store — threading, dedupe, ordering");
const store = createConversationStore();
store.addIncoming({ from: bob, body: "gm", ts: 100, seq: 1 });
store.addIncoming({ from: bob, body: "gm", ts: 100, seq: 1 });   // duplicate log pull
store.addOutgoing(bob, "hey", 150);
store.addIncoming({ from: bob, body: "wanna collab?", ts: 200, seq: 2 });
const thread = store.thread(bob);
check("dedupes the repeated incoming", thread.length === 3);
check("chronological order", thread[0].body === "gm" && thread[1].body === "hey" && thread[2].body === "wanna collab?");
check("directions tracked", thread[0].dir === "in" && thread[1].dir === "out");

const carol = metaAddress(createIdentity());
store.addIncoming({ from: carol, body: "hello", ts: 500, seq: 9 });
const list = store.list();
check("two threads listed", list.length === 2);
check("most-recent thread first (carol)", list[0].peer === carol && list[0].preview === "hello");
check("thread preview + count", list[1].peer === bob && list[1].count === 3);

console.log("\n5. Store snapshot round-trips");
const restored = createConversationStore(store.snapshot());
check("restored store keeps both threads", restored.list().length === 2);
check("restored thread intact", restored.thread(bob).length === 3);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
