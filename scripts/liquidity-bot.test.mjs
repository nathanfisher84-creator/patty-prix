// Tests the liquidity-bot's pure logic. Run: node scripts/liquidity-bot.test.mjs
import { buildSnapshot, liquidityDrop, alertsFor, formatAlert, parseCommand, monitorOnce, trendAlerts, entryRead, formatEntry } from "./liquidity-bot.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

console.log("\n1. buildSnapshot prefers Meteora's native reserve");
const snap = buildSnapshot({ safety: 80, tier: "clean", smartMoneyHolders: 1, smartMoneyReliable: true, dataComplete: true,
  market: { symbol: "BONK", priceUsd: 1, liqQuote: 50, meteoraQuote: 120, liquidityUsd: 90000, dexId: "meteora" },
  flags: [{ level: "red", id: "x", text: "bad" }, { level: "green", id: "g", text: "good" }] }, MINT);
check("uses meteoraQuote over liqQuote", snap.liqQuote === 120);
check("keeps only red flags with ids", snap.flags.length === 1 && snap.flags[0].id === "x");
check("carries symbol + tier", snap.symbol === "BONK" && snap.tier === "clean");

console.log("\n2. liquidityDrop — the core 'going down' signal");
check("pool SOL −25% → red drop alert", liquidityDrop({ liqQuote: 100 }, { liqQuote: 75 }, 15)?.kind === "liquidity-drop");
check("drop copy says 'pool SOL' when using quote", /pool SOL/.test(liquidityDrop({ liqQuote: 100 }, { liqQuote: 75 }, 15).text));
check("falls back to USD liquidity when no quote", /liquidity −/.test(liquidityDrop({ liquidityUsd: 100000 }, { liquidityUsd: 70000 }, 15).text));
check("small dip below threshold → no alert", liquidityDrop({ liqQuote: 100 }, { liqQuote: 92 }, 15) === null);
check("liquidity rising → no alert", liquidityDrop({ liqQuote: 100 }, { liqQuote: 130 }, 15) === null);

console.log("\n3. alertsFor — combines drop + diffScan, dedupes pump-drain");
const base = { token: MINT, safety: 80, tier: "clean", dataComplete: true, smartMoneyReliable: true, flags: [] };
const plainDrop = alertsFor({ ...base, liqQuote: 100, priceUsd: 1 }, { ...base, liqQuote: 70, priceUsd: 1 }, 15);
check("plain liquidity drop (no pump) is reported", plainDrop.some(a => a.kind === "liquidity-drop"));
const pumpDrain = alertsFor({ ...base, liqQuote: 100, priceUsd: 1 }, { ...base, liqQuote: 70, priceUsd: 1.5, dexId: "meteora" }, 15);
check("pump + drain reports the richer pump alert", pumpDrain.some(a => a.kind === "liq-pull-on-pump"));
check("...and suppresses the duplicate plain drop", !pumpDrain.some(a => a.kind === "liquidity-drop"));

console.log("\n4. formatAlert renders a Telegram message");
const msg = formatAlert(buildSnapshot({ safety: 40, tier: "high-risk", market: { symbol: "TRAP", liqQuote: 10 } }, MINT),
  [{ level: "red", kind: "liquidity-drop", text: "Liquidity dropping — pool SOL −40%" }]);
check("message has an alarm header + the token", /🚨/.test(msg) && /TRAP/.test(msg));
check("message includes a Solscan link + safety", /solscan\.io\/token/.test(msg) && /safety 40/.test(msg));

console.log("\n5. parseCommand");
check("/watch <mint>", parseCommand("/watch " + MINT).cmd === "watch" && parseCommand("/watch " + MINT).arg === MINT);
check("strips @botname", parseCommand("/list@RugMoonBot").cmd === "list");
check("/scan with arg", parseCommand("/scan " + MINT).cmd === "scan");
check("unknown", parseCommand("hello").cmd === "unknown");

console.log("\n6. monitorOnce — baselines first, alerts on the second pass");
const sent = [];
const envStub = { HELIUS_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" };
// stub scanToken: first call full liquidity, second call drained
let call = 0;
const scanStub = async () => {
  call++;
  const liqQuote = call === 1 ? 100 : 60;
  return { safety: 80, tier: "clean", smartMoneyHolders: 0, smartMoneyReliable: true, dataComplete: true,
    market: { symbol: "BONK", priceUsd: 1, liqQuote, liquidityUsd: 90000, dexId: "meteora" }, flags: [] };
};
// Intercept Telegram by stubbing global fetch (sendTelegram uses it).
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { if (String(url).includes("sendMessage")) sent.push(JSON.parse(opts.body).text); return { json: async () => ({ ok: true }) }; };
const state = { watch: new Set([MINT]), last: new Map(), baseline: new Map(), cooldown: new Map(), muted: false };
const cfg = { dropPct: 15, pollSeconds: 60, file: "/tmp/does-not-matter.json", cooldownMs: 30 * 60_000, baselineMs: 30 * 60_000, volDropPct: 40, holderDropPct: 10 };
await monitorOnce(envStub, cfg, state, scanStub);
check("first pass only baselines (no alert)", sent.length === 0);
await monitorOnce(envStub, cfg, state, scanStub);
check("second pass alerts on the 40% drain", sent.length === 1 && /−40%|Liquidity/.test(sent[0]));
check("cooldown suppresses the repeat drain alert", (await (async () => { const before = sent.length; await monitorOnce(envStub, cfg, state, scanStub); return sent.length === before; })()));
globalThis.fetch = realFetch;

console.log("\n7. trendAlerts — slow volume/holder trends vs baseline");
const baseSnap = { volume24h: 100000, holders: 1000 };
check("volume −50% → volume-fade (yellow)", trendAlerts(baseSnap, { volume24h: 50000, holders: 1000 }, cfg).some(a => a.kind === "volume-fade"));
check("holders −20% → holders-drop (red)", trendAlerts(baseSnap, { volume24h: 100000, holders: 800 }, cfg).some(a => a.kind === "holders-drop" && a.level === "red"));
check("stable volume/holders → no trend alert", trendAlerts(baseSnap, { volume24h: 98000, holders: 1000 }, cfg).length === 0);

console.log("\n8. entryRead — hedged, structure-based, NFA");
const good = entryRead({ tier: "clean", liqQuote: 100, holders: 1200, volume24h: 90000, priceChange24h: 10, lpLockedPct: 100, smartMoneyHolders: 2 }, { liqQuote: 95, holders: 1000, volume24h: 90000 });
check("clean + stable liq + growing holders + locked LP + smart money → constructive", good.rating === "constructive");
const bad = entryRead({ tier: "high-risk", liqQuote: 40, holders: 700, volume24h: 10000, priceChange24h: 300 }, { liqQuote: 100, holders: 1000, volume24h: 90000 });
check("high-risk + draining + holders fleeing + vertical pump → poor", bad.rating === "poor");
check("entry read never omits the NFA disclaimer", /NFA/.test(formatEntry({ token: MINT, symbol: "X" }, good)));
check("vertical pump is called out as top-risk", bad.reasons.some(r => /top/i.test(r)));

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
