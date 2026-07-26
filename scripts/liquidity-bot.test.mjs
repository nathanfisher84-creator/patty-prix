// Tests the liquidity-bot's pure logic. Run: node scripts/liquidity-bot.test.mjs
import { buildSnapshot, liquidityDrop, alertsFor, formatAlert, parseCommand, monitorOnce, trendAlerts, entryRead, formatEntry,
  improvementAlerts, priceMoveAlert, buildDigest, shouldDigest, formatHolders, loadWhales,
  discoveryCfg, pickNewWhales, formatDiscovery,
  serializeState, parseStateMessage, applyState, STATE_MARKER } from "./liquidity-bot.mjs";

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
const state = { watch: new Set([MINT]), last: new Map(), baseline: new Map(), cooldown: new Map(), priceAlerts: new Map(), muted: false };
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

console.log("\n9. improvementAlerts — the positive side (still NFA)");
check("LP just locked → green lp-locked", improvementAlerts({ lpLockedPct: 0, holders: 100, tier: "caution" }, { lpLockedPct: 100, holders: 100, tier: "caution" }, {}).some(a => a.kind === "lp-locked"));
check("holders +30% → green holders-grow", improvementAlerts({ lpLockedPct: 0, holders: 100, tier: "caution" }, { lpLockedPct: 0, holders: 130, tier: "caution" }, {}).some(a => a.kind === "holders-grow"));
check("tier upgrade → green tier-up", improvementAlerts({ lpLockedPct: 0, holders: 100, tier: "caution" }, { lpLockedPct: 0, holders: 100, tier: "clean" }, {}).some(a => a.kind === "tier-up"));
check("nothing improved → no alert", improvementAlerts({ lpLockedPct: 0, holders: 100, tier: "caution" }, { lpLockedPct: 0, holders: 101, tier: "caution" }, {}).length === 0);

console.log("\n10. priceMoveAlert");
check("+25% move → green price-move", priceMoveAlert({ priceUsd: 1 }, { priceUsd: 1.25 }, 20)?.level === "green");
check("−30% move → red price-move", priceMoveAlert({ priceUsd: 1 }, { priceUsd: 0.7 }, 20)?.level === "red");
check("small move under threshold → null", priceMoveAlert({ priceUsd: 1 }, { priceUsd: 1.05 }, 20) === null);

console.log("\n11. formatHolders — breakdown + deployer bag warning");
const fh = formatHolders([{ pct: 30, owner: "devWallet" }, { pct: 8, owner: "x" }], { creator: "devWallet" });
check("shows top holder percentages", /30% · 8%/.test(fh));
check("warns when the deployer still holds a bag", /Deployer/.test(fh) && /still holds 30%/.test(fh));

console.log("\n12. buildDigest");
check("empty watchlist → null", buildDigest([]) === null);
const dg = buildDigest([{ snap: { token: MINT, symbol: "BONK", safety: 82, tier: "clean", liqQuote: 110, holders: 5000 }, base: { liqQuote: 100 } }]);
check("digest lists the token + liq trend + NFA", /BONK/.test(dg) && /\+10%/.test(dg) && /NFA/.test(dg));

console.log("\n13. shouldDigest — once per UTC day, at/after the hour");
const h14 = Date.UTC(2025, 5, 1, 14); // 14:00 UTC on a day
check("new day, past the hour → true", shouldDigest("2025-4-31", h14, 13) === true);
check("already sent today → false", shouldDigest("2025-5-1", h14, 13) === false);
check("new day but before the hour → false", shouldDigest("2025-4-31", Date.UTC(2025, 5, 1, 9), 13) === false);

console.log("\n14. smart-money (whale) management");
check("/addwhale parses wallet + label", (() => { const p = parseCommand("/addwhale " + MINT + " Cupsey"); return p.cmd === "addwhale" && p.wallet === MINT && p.label === "Cupsey"; })());
check("/whales parses", parseCommand("/whales").cmd === "whales");
check("/delwhale parses", parseCommand("/delwhale " + MINT).cmd === "delwhale");
check("loadWhales dedupes across seed entries", loadWhales(null, JSON.stringify([{ wallet: MINT, label: "a" }, { wallet: MINT, label: "b" }])).length === 1);
check("loadWhales rejects invalid addresses", loadWhales(null, JSON.stringify(["not-a-wallet", MINT])).length === 1);
check("loadWhales accepts plain address strings", loadWhales(null, JSON.stringify([MINT]))[0].wallet === MINT);

console.log("\n15. whale auto-discovery");
check("/discoverwhales parses", parseCommand("/discoverwhales").cmd === "discoverwhales");
check("/discover alias parses", parseCommand("/discover").cmd === "discoverwhales");
const dcfg = discoveryCfg();
check("bot discovery config is lighter than CLI defaults", dcfg.trending <= 5 && dcfg.perToken <= 10 && dcfg.swapPages <= 1);
check("discovery config keeps the smart-money bar", dcfg.minPnlUsd >= 5000 && dcfg.minTrades >= 5);
const W1 = "So11111111111111111111111111111111111111112";
check("pickNewWhales filters out already-tracked", pickNewWhales([{ wallet: MINT }, { wallet: W1 }], [{ wallet: MINT }]).length === 1);
check("pickNewWhales on empty existing keeps all", pickNewWhales([{ wallet: MINT }, { wallet: W1 }], []).length === 2);
const disc = formatDiscovery([{ wallet: MINT, realizedUsd: 42000, winRatePct: 68 }], 1, 5);
check("discovery summary shows PnL + win rate", /\+\$42,000/.test(disc) && /68% win/.test(disc));
check("discovery summary reports how many were added", /Added 1 new wallet/.test(disc));
check("discovery summary carries NFA", /NFA/.test(disc));
check("no results → honest 'none cleared the bar' message", /no wallets cleared/i.test(formatDiscovery([], 0, 5)));

console.log("\n16. flagged wallets (warn-me-if-this-wallet-holds)");
check("/flagwallet parses wallet + label", (() => { const p = parseCommand("/flagwallet " + MINT + " Known rugger"); return p.cmd === "flagwallet" && p.wallet === MINT && p.label === "Known rugger"; })());
check("/flagged parses", parseCommand("/flagged").cmd === "flagged");
check("/unflagwallet parses", parseCommand("/unflagwallet " + MINT).cmd === "unflagwallet");
check("flagged list reuses the validated loader", loadWhales(null, JSON.stringify([{ wallet: MINT, label: "x" }, "not-a-wallet"])).length === 1);
// A flagged wallet appearing = a new red flag with a stable id → diffScan alerts.
const flagBase = { token: MINT, safety: 80, tier: "clean", dataComplete: true, smartMoneyReliable: true, flags: [] };
const flagAlert = alertsFor({ ...flagBase }, { ...flagBase, flags: [{ level: "red", id: "flagged-wallet", text: "Flagged wallet holding this token (Known rugger)" }] }, 15);
check("flagged wallet entering a watched token fires an alert", flagAlert.some(a => a.kind === "new-flag" && /Flagged wallet/.test(a.text)));

console.log("\n17. permanent state via a pinned Telegram message");
const W2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const full = { watch: new Set([MINT, W2]), whales: [{ wallet: W1, label: "Cupsey" }], flagged: [{ wallet: W2, label: "rugger" }], priceAlerts: new Map([[MINT, 20]]) };
const text = serializeState(full);
check("serialized state carries the marker", text.includes(STATE_MARKER));
const round = parseStateMessage(text);
check("round-trips watched tokens", round.watch.length === 2 && round.watch.includes(MINT));
check("round-trips whales with labels", round.whales[0].wallet === W1 && round.whales[0].label === "Cupsey");
check("round-trips flagged wallets", round.flagged[0].wallet === W2);
check("round-trips price alerts", round.alerts[0][0] === MINT && round.alerts[0][1] === 20);
check("ignores a message that isn't ours", parseStateMessage("just a normal message") === null);
check("survives corrupt JSON without throwing", parseStateMessage(STATE_MARKER + "\n{not json") === null);
check("rejects invalid addresses inside saved state", parseStateMessage(`${STATE_MARKER}\n{"watch":["bad"],"whales":[],"flagged":[],"alerts":[]}`).watch.length === 0);
// applyState merges (union) rather than clobbering env/file seeds
const live = { watch: new Set(["So11111111111111111111111111111111111111112"]), whales: [], flagged: [], priceAlerts: new Map() };
applyState(live, round);
check("restore merges with existing seeds (union)", live.watch.size === 3);
check("restore fills whales + flagged", live.whales.length === 1 && live.flagged.length === 1);
check("restore is a no-op on null", applyState(live, null).watch.size === 3);
check("/save parses", parseCommand("/save").cmd === "save");

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
