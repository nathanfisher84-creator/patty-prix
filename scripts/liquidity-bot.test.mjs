// Tests the liquidity-bot's pure logic. Run: node scripts/liquidity-bot.test.mjs
import { buildSnapshot, liquidityDrop, alertsFor, formatAlert, parseCommand, monitorOnce, trendAlerts, entryRead, formatEntry,
  improvementAlerts, priceMoveAlert, buildDigest, shouldDigest, formatHolders, loadWhales,
  discoveryCfg, pickNewWhales, formatDiscovery,
  serializeState, parseStateMessage, applyState, STATE_MARKER,
  seedSeenMints, detectFirstBuys, formatFirstBuy, walletPassOnce,
  avgEntryForMint, summarizeEntries, formatEntries, holderEntryReport, formatEntriesCompact } from "./liquidity-bot.mjs";

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

console.log("\n18. copy-trade: first-time buy signals");
const NEWTOK = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const t = (side, mint, ts, usd, sig) => ({ side, mint, timestamp: ts, quoteUsd: usd, signature: sig || "" });
check("seedSeenMints collects every mint (buys AND sells)", seedSeenMints([t("buy", MINT, 1, 500), t("sell", W1, 2, 900)]).size === 2);
const seen0 = new Set([MINT]);
const firsts = detectFirstBuys([t("buy", MINT, 100, 500), t("buy", NEWTOK, 100, 500)], seen0, { sinceTs: 0, minUsd: 0 });
check("only the unseen token counts as a first buy", firsts.length === 1 && firsts[0].mint === NEWTOK);
check("a sell is never a first buy", detectFirstBuys([t("sell", NEWTOK, 100, 900)], seen0, {}).length === 0);
check("stale buys outside the lookback are ignored", detectFirstBuys([t("buy", NEWTOK, 50, 500)], seen0, { sinceTs: 100 }).length === 0);
check("dust buys under minUsd are ignored", detectFirstBuys([t("buy", NEWTOK, 100, 5)], seen0, { minUsd: 200 }).length === 0);
check("two buys of the same new token fire once", detectFirstBuys([t("buy", NEWTOK, 100, 500), t("buy", NEWTOK, 101, 600)], seen0, {}).length === 1);
const fbMsg = formatFirstBuy("Cupsey", { mint: NEWTOK, quoteUsd: 4200, signature: "sig" }, { safety: 22, tier: "high-risk", market: { symbol: "TRAP" }, flags: [{ level: "red", text: "Mint authority is ACTIVE" }] });
check("signal names who bought + the size", /FIRST BUY/.test(fbMsg) && /Cupsey/.test(fbMsg) && /\$4\.2K/.test(fbMsg));
check("signal pairs in the safety verdict", /22\/100/.test(fbMsg) && /HIGH RISK/.test(fbMsg));
check("signal surfaces the worst red flag", /Mint authority is ACTIVE/.test(fbMsg));
check("signal carries NFA + history caveat", /NFA/.test(fbMsg) && /first buy we can see/i.test(fbMsg));

// End-to-end with REAL Helius-shaped swap events: baseline pass is silent, then a
// genuinely new buy fires exactly one signal, and a repeat of it stays quiet.
const WSOL = "So11111111111111111111111111111111111111112";
const buyTx = (mint, ts, sol, sig) => ({
  signature: sig, timestamp: ts,
  events: { swap: {
    nativeInput: { amount: String(sol * 1e9) },                                  // paid SOL
    tokenOutputs: [{ mint, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }], // got token
  } },
});
const sentSignals = [];
const realFetch2 = globalThis.fetch;
globalThis.fetch = async (url, opts) => { if (String(url).includes("sendMessage")) sentSignals.push(JSON.parse(opts.body).text); return { json: async () => ({ ok: true }) }; };
let pass = 0;
const clientStub = { walletSwaps: async () => {
  pass++;
  const held = buyTx(MINT, 2900, 5, "old");                 // an existing position
  return pass === 1 ? [held] : [held, buyTx(NEWTOK, 2950, 5, "new")]; // then a NEW token
} };
const wState = { signalsOn: true, whales: [{ wallet: W1, label: "Cupsey" }], walletSeen: new Map(), smartMoney: null, flaggedSet: null, muted: false, solPriceUsd: 150 };
const wCfg = { signalLookbackMin: 30, signalMinUsd: 200, signalSwapPages: 1 };
const scanStub2 = async () => ({ safety: 50, tier: "caution", market: { symbol: "NEW" }, flags: [] });
const p1 = await walletPassOnce({ HELIUS_API_KEY: "k" }, wCfg, wState, clientStub, 3000, scanStub2);
check("first wallet pass baselines silently (no alert on an existing bag)", p1.length === 0 && sentSignals.length === 0);
const p2 = await walletPassOnce({ HELIUS_API_KEY: "k" }, wCfg, wState, clientStub, 3000, scanStub2);
check("a genuinely NEW token fires exactly one signal", p2.length === 1 && p2[0].mint === NEWTOK, `fired ${p2.length}`);
check("the signal message is the FIRST BUY card", sentSignals.length === 1 && /FIRST BUY/.test(sentSignals[0]));
const p3 = await walletPassOnce({ HELIUS_API_KEY: "k" }, wCfg, wState, clientStub, 3000, scanStub2);
check("the same position does not re-fire on the next pass", p3.length === 0 && sentSignals.length === 1);
check("signals off → no work done", (await walletPassOnce({}, wCfg, { ...wState, signalsOn: false }, clientStub, 3000)).length === 0);
globalThis.fetch = realFetch2;
check("/signals parses on/off", parseCommand("/signals on").cmd === "signals" && parseCommand("/signals on").arg === "on");

console.log("\n19. top-holder average entry price");
const tr = (side, mint, ts, tokenAmount, quoteUsd) => ({ side, mint, timestamp: ts, tokenAmount, quoteUsd });
// Bought 1000 tokens for $100 → avg $0.10
check("average cost basis from a single buy", avgEntryForMint([tr("buy", MINT, 1, 1000, 100)], MINT).avgPrice === 0.1);
// Two buys: 1000@$100 + 1000@$300 → 2000 tokens, $400 → $0.20
check("averages across multiple buys", avgEntryForMint([tr("buy", MINT, 1, 1000, 100), tr("buy", MINT, 2, 1000, 300)], MINT).avgPrice === 0.2);
// Buy 1000@$100 then sell half → cost basis per token unchanged at $0.10
const afterSell = avgEntryForMint([tr("buy", MINT, 1, 1000, 100), tr("sell", MINT, 2, 500, 250)], MINT);
check("selling reduces position but not avg price", Math.abs(afterSell.avgPrice - 0.1) < 1e-9 && afterSell.tokens === 500);
check("ignores trades of other tokens", avgEntryForMint([tr("buy", W1, 1, 1000, 999)], MINT) === null);
check("fully exited wallet → null (no current basis)", avgEntryForMint([tr("buy", MINT, 1, 1000, 100), tr("sell", MINT, 2, 1000, 500)], MINT) === null);
check("no history → null (airdropped/transferred)", avgEntryForMint([], MINT) === null);

const rows = [
  { owner: "a", share: 0.5, entry: { avgPrice: 0.01, tokens: 1000, costUsd: 10, buys: 1 } },
  { owner: "b", share: 0.3, entry: { avgPrice: 0.05, tokens: 200, costUsd: 10, buys: 1 } },
  { owner: "c", share: 0.2, entry: null }, // airdropped / unpriceable
];
const sum19 = summarizeEntries(rows, 0.10);
check("counts priced vs unpriced holders", sum19.priced === 2 && sum19.unpriced === 1);
check("size-weights the average entry", sum19.weighted > 0.01 && sum19.weighted < 0.05, `w=${sum19.weighted}`);
check("computes the profit multiple vs current price", sum19.multiple > 1);
check("counts how many are in profit", sum19.inProfit === 2);
const msg19 = formatEntries(MINT, "BONK", 20, rows, sum19, 0.10);
check("report shows current + avg entry", /Current price/.test(msg19) && /Avg entry \(size-weighted\)/.test(msg19));
check("report warns about unpriced (airdropped) holders", /no on-chain buy/.test(msg19));
check("report carries NFA + incompleteness caveat", /NFA/.test(msg19) && /may be incomplete/i.test(msg19));
const deep = summarizeEntries([{ owner: "a", share: 1, entry: { avgPrice: 0.01, tokens: 100, costUsd: 1, buys: 1 } }], 0.10);
check("10x profit flags high dump risk", /high dump risk/.test(formatEntries(MINT, "X", 10, [], deep, 0.10)));
check("no priceable holders → honest message", /Couldn't price any/.test(formatEntries(MINT, "X", 10, [], summarizeEntries([{ owner: "a", entry: null }], 1), 1)));

// Orchestrator with stubbed RPC: excludes pools, ranks by balance, prices each.
const rep = await holderEntryReport(MINT, {
  getTokenAccounts: async () => ({ result: { token_accounts: [
    { owner: "poolOwner", amount: 9999 }, { owner: "whaleA", amount: 500 }, { owner: "whaleB", amount: 300 },
  ] } }),
  getWalletSwaps: async (w) => (w === "whaleA"
    ? [{ events: { swap: { nativeInput: { amount: String(1e9) }, tokenOutputs: [{ mint: MINT, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } }] } }, timestamp: 1 }]
    : []),
  topN: 10, excluded: new Set(["poolOwner"]), solPriceUsd: 150,
});
check("excludes pool owners from holders", rep.rows.every(r => r.owner !== "poolOwner") && rep.ranked === 2);
check("prices the holder with swap history", rep.rows.find(r => r.owner === "whaleA").entry?.avgPrice > 0);
check("leaves the no-history holder unpriced", rep.rows.find(r => r.owner === "whaleB").entry === null);
check("/entries parses mint + N", (() => { const p = parseCommand("/entries " + MINT + " 50"); return p.cmd === "entries" && p.mint === MINT && p.topN === "50"; })());

console.log("\n19b. compact entries line (folded into /scan)");
const compact = formatEntriesCompact(10, sum19, 0.10);
check("compact line is short and shows avg + multiple", /Top 10 entries/.test(compact) && /avg /.test(compact) && /× up/.test(compact));
check("compact line flags airdropped holders", /no on-chain buy/.test(compact));
const compactDeep = formatEntriesCompact(10, deep, 0.10);
check("deep profit shows the dump-risk tag", /deep in profit/.test(compactDeep));
const aligned = summarizeEntries([{ owner: "a", share: 1, entry: { avgPrice: 0.1, tokens: 100, costUsd: 10, buys: 1 } }], 0.10);
check("entry near spot reads as aligned", /near your entry/.test(formatEntriesCompact(10, aligned, 0.10)));
const under = summarizeEntries([{ owner: "a", share: 1, entry: { avgPrice: 0.5, tokens: 100, costUsd: 50, buys: 1 } }], 0.10);
check("holders underwater are described as such", /underwater/.test(formatEntriesCompact(10, under, 0.10)) && /× down/.test(formatEntriesCompact(10, under, 0.10)));
check("nothing priceable → compact 'no on-chain buy' note", /no on-chain buy/.test(formatEntriesCompact(10, summarizeEntries([{ owner: "a", entry: null }], 1), 1)));
check("empty summary → empty string (nothing appended to /scan)", formatEntriesCompact(10, summarizeEntries([], 1), 1) === "");

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
