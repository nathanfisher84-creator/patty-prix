// Tests the pure watchlist diff/alert + freemium logic. Run: node test/watchlist.test.mjs
import { diffScan, canWatch, summarizeAlerts, FREE_WATCH_LIMIT, SAFETY_DROP_ALERT } from "../watchlist.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

const scan = (o = {}) => ({
  token: "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  safety: 80, tier: "clean", smartMoneyHolders: 0, flags: [], symbol: "BONK", ...o,
});

console.log("\n1. No change → no alerts");
check("identical scans yield nothing", diffScan(scan(), scan()).length === 0);
check("null prev (first scan) is silent", diffScan(null, scan()).length === 0);
check("errored curr is silent", diffScan(scan(), { error: "x" }).length === 0);

console.log("\n2. Safety drop");
const drop = diffScan(scan({ safety: 82 }), scan({ safety: 82 - SAFETY_DROP_ALERT }));
check("a drop of exactly the threshold alerts", drop.some(a => a.kind === "safety-drop"));
check("drop alert is red", drop.find(a => a.kind === "safety-drop").level === "red");
const smallDrop = diffScan(scan({ safety: 82 }), scan({ safety: 70 }));
check("a sub-threshold drop stays quiet", !smallDrop.some(a => a.kind === "safety-drop"));
check("safety improving never alerts on drop", !diffScan(scan({ safety: 50 }), scan({ safety: 90 })).some(a => a.kind === "safety-drop"));

console.log("\n3. Tier downgrade");
const td = diffScan(scan({ tier: "clean", safety: 78 }), scan({ tier: "high-risk", safety: 77 }));
check("clean → high-risk downgrades", td.some(a => a.kind === "tier-down" && a.level === "red"));
const tup = diffScan(scan({ tier: "high-risk" }), scan({ tier: "clean" }));
check("upgrade does not fire a downgrade alert", !tup.some(a => a.kind === "tier-down"));

console.log("\n4. Smart-money movement");
const exit = diffScan(scan({ smartMoneyHolders: 3 }), scan({ smartMoneyHolders: 0 }));
check("full smart-money exit alerts red", exit.some(a => a.kind === "smart-money-exit" && a.level === "red"));
check("full-exit copy says 'fully exited'", /fully exited/.test(exit.find(a => a.kind === "smart-money-exit").text));
const trim = diffScan(scan({ smartMoneyHolders: 3 }), scan({ smartMoneyHolders: 1 }));
check("partial exit alerts (trimming)", /trimming/.test(trim.find(a => a.kind === "smart-money-exit").text));
const arrive = diffScan(scan({ smartMoneyHolders: 0 }), scan({ smartMoneyHolders: 2 }));
check("smart money arriving is a green alert", arrive.some(a => a.kind === "smart-money-in" && a.level === "green"));

console.log("\n5. New red flags");
const nf = diffScan(
  scan({ flags: [{ level: "green", text: "all good" }] }),
  scan({ flags: [{ level: "red", text: "Mint authority is ACTIVE — creator can mint unlimited tokens" }] }),
);
check("a newly-appeared red flag alerts", nf.some(a => a.kind === "new-flag" && /Mint authority/.test(a.text)));
const sameFlag = diffScan(
  scan({ flags: [{ level: "red", text: "Low liquidity" }] }),
  scan({ flags: [{ level: "red", text: "Low liquidity" }] }),
);
check("a pre-existing red flag does NOT re-alert", !sameFlag.some(a => a.kind === "new-flag"));

console.log("\n6. Freemium limit");
check(`free plan caps at ${FREE_WATCH_LIMIT}`, canWatch(FREE_WATCH_LIMIT).ok === false);
check("under the cap is allowed", canWatch(FREE_WATCH_LIMIT - 1).ok === true);
check("remaining counts down", canWatch(2).remaining === FREE_WATCH_LIMIT - 2);
check("at the cap gives an upgrade reason", /upgrade/i.test(canWatch(FREE_WATCH_LIMIT).reason));
check("premium lifts the cap", canWatch(999, true).ok === true && canWatch(999, true).remaining === Infinity);

console.log("\n7. Batch summary for notifications");
check("nothing notable → null (no notification)", summarizeAlerts([{ token: "a", alerts: [] }]) === null);
const sum = summarizeAlerts([
  { token: "a", symbol: "AAA", alerts: [{ level: "red", kind: "safety-drop", text: "Safety fell 30 pts" }] },
  { token: "b", symbol: "BBB", alerts: [{ level: "green", kind: "smart-money-in", text: "Smart money moved in" }] },
]);
check("summary counts affected tokens", sum.count === 2);
check("summary flags red presence", sum.hasRed === true);
check("summary title mentions the count", /2 watched tokens/.test(sum.title));
check("summary body names a token", /AAA:/.test(sum.body));

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
