// Patty Prix — paper-trading MEV bot (cross-DEX arbitrage, Solana).
//
// Scans DexScreener for tokens that trade in MULTIPLE pools (Raydium, Orca,
// Meteora, PumpSwap, …), looks for price spreads between pools, and paper-
// trades them: buy in the cheap pool, sell in the expensive one. No wallet,
// no keys, no real transactions — every fill is simulated, and the simulation
// is deliberately pessimistic so it teaches what real MEV bots are up against:
//
//   1. LATENCY  — an opportunity spotted this poll is *filled at next poll's
//                 prices*. Public-API bots are seconds behind; spreads decay.
//   2. FEES     — both swap legs pay the pool fee, and every attempt pays a
//                 priority fee + Jito-style tip, even when it loses.
//   3. IMPACT   — your own trade moves the price (constant-product estimate),
//                 so thin pools eat your edge.
//   4. RACING   — a coin flip (configurable land rate) decides whether your
//                 "bundle" landed first. Lose the race → pay the tip, no fill.
//
// Usage:
//   node scripts/mev-paper-bot.mjs              # run forever, poll every 10s
//   node scripts/mev-paper-bot.mjs --once       # single scan (no fills — fills
//                                               # need a second poll for latency)
//   node scripts/mev-paper-bot.mjs --stats      # print ledger summary and exit
//   node scripts/mev-paper-bot.mjs --reset      # wipe the paper ledger
//
// Options (all optional):
//   --interval <ms>    poll interval, default 10000
//   --size <usd>       max paper trade size, default 100
//   --min-edge <pct>   min NET edge (after fees) to attempt, default 0.3
//   --land-rate <pct>  chance an attempt lands first, default 60
//   --tokens <a,b,c>   comma-separated mints to scan (default list below)
//
// Ledger lives in scripts/paper-ledger.json (gitignored).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { pathToFileURL, fileURLToPath } from "url";
import { dirname, join } from "path";

/* ================================================================
   Config
   ================================================================ */

// Default scan list: liquid Solana tokens that actually trade in many pools
// across different DEXes — cross-pool spreads need at least two pools. Fresh
// pump.fun-style tokens usually live in a single PumpSwap pool, so there is
// nothing to arb; that's why the Patty Prix racers aren't the default here.
export const DEFAULT_TOKENS = [
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", // POPCAT
];

export const DEFAULTS = {
  intervalMs: 10_000,
  maxTradeUsd: 100,     // paper size per attempt
  minNetEdgePct: 0.3,   // only attempt if net edge (after all costs) beats this
  landRatePct: 60,      // how often we "win the race" vs other bots
  swapFeePct: 0.25,     // per leg (Raydium-style constant-product fee)
  txCostUsd: 0.15,      // priority fee + tip per ATTEMPT, paid win or lose
  minPoolLiqUsd: 10_000,// ignore pools thinner than this (honeypot/dust filter)
  maxLiqFraction: 0.005,// never size more than 0.5% of the thinner pool
};

const API = "https://api.dexscreener.com/token-pairs/v1/solana/";
const LEDGER_PATH = join(dirname(fileURLToPath(import.meta.url)), "paper-ledger.json");

/* ================================================================
   Opportunity detection
   ================================================================ */

export async function fetchPools(tokens, fetchFn = fetch) {
  const results = await Promise.all(tokens.map(a =>
    fetchFn(API + a).then(r => (r && r.ok === false ? [] : r.json())).catch(() => [])
  ));
  return results.flat();
}

// Group pools by base token, keep only real, liquid pools with a USD price.
export function usablePoolsByToken(pairs, cfg = DEFAULTS) {
  const byToken = {};
  for (const p of pairs || []) {
    const addr = p.baseToken?.address;
    const price = parseFloat(p.priceUsd);
    const liq = p.liquidity?.usd || 0;
    if (!addr || !price || liq < cfg.minPoolLiqUsd) continue;
    (byToken[addr] ||= []).push({
      dex: p.dexId,
      pairAddress: p.pairAddress,
      symbol: p.baseToken.symbol,
      price,
      liqUsd: liq,
    });
  }
  for (const addr of Object.keys(byToken)) {
    if (byToken[addr].length < 2) delete byToken[addr]; // need 2+ pools to arb
  }
  return byToken;
}

// Constant-product price impact estimate: trading `size` into a pool with
// `liq` total USD liquidity (~liq/2 per side) moves the price about
// size / (liq/2). It's rough, but it's the right order of magnitude and
// correctly punishes thin pools.
export function impactPct(sizeUsd, liqUsd) {
  return (sizeUsd / (liqUsd / 2)) * 100;
}

// Find the best cross-pool spread for each token and cost it out.
export function findOpportunities(byToken, cfg = DEFAULTS) {
  const opps = [];
  for (const pools of Object.values(byToken)) {
    const sorted = [...pools].sort((a, b) => a.price - b.price);
    const buy = sorted[0];                 // cheapest pool
    const sell = sorted[sorted.length - 1]; // priciest pool
    if (buy.pairAddress === sell.pairAddress) continue;

    const size = Math.min(cfg.maxTradeUsd, Math.min(buy.liqUsd, sell.liqUsd) * cfg.maxLiqFraction);
    const grossPct = ((sell.price - buy.price) / buy.price) * 100;
    const costPct =
      cfg.swapFeePct * 2 +                       // fee on both legs
      impactPct(size, buy.liqUsd) +              // we push the cheap pool up
      impactPct(size, sell.liqUsd) +             // and the rich pool down
      (cfg.txCostUsd / size) * 100;              // priority fee + tip
    const netPct = grossPct - costPct;

    opps.push({
      symbol: buy.symbol,
      buy: { dex: buy.dex, pair: buy.pairAddress, price: buy.price },
      sell: { dex: sell.dex, pair: sell.pairAddress, price: sell.price },
      sizeUsd: round2(size),
      grossPct: round4(grossPct),
      costPct: round4(costPct),
      netPct: round4(netPct),
    });
  }
  return opps.sort((a, b) => b.netPct - a.netPct);
}

/* ================================================================
   Simulated execution — fills use NEXT poll's prices (latency)
   ================================================================ */

// A pending attempt from last poll is settled against this poll's pools.
// The spread we saw is usually gone by now; that is the whole lesson.
export function settleAttempt(attempt, byToken, cfg = DEFAULTS, rand = Math.random) {
  const pools = Object.values(byToken).flat();
  const buyNow = pools.find(p => p.pairAddress === attempt.buy.pair);
  const sellNow = pools.find(p => p.pairAddress === attempt.sell.pair);

  const base = {
    ...attempt,
    settledAt: new Date().toISOString(),
    feesUsd: round4(cfg.txCostUsd),
  };

  // Pool vanished from the feed → treat as a failed land (still paid the tip).
  if (!buyNow || !sellNow) {
    return { ...base, outcome: "no-land", pnlUsd: -cfg.txCostUsd, note: "pool dropped from feed" };
  }

  // Did our bundle land first, or did a faster bot beat us? Either way the
  // priority fee is spent.
  if (rand() * 100 >= cfg.landRatePct) {
    return { ...base, outcome: "no-land", pnlUsd: -cfg.txCostUsd, note: "lost the race" };
  }

  // Landed: recompute the round trip at CURRENT prices, with fees and impact.
  const size = attempt.sizeUsd;
  const grossPct = ((sellNow.price - buyNow.price) / buyNow.price) * 100;
  const costPct = cfg.swapFeePct * 2 + impactPct(size, buyNow.liqUsd) + impactPct(size, sellNow.liqUsd);
  const pnlUsd = size * ((grossPct - costPct) / 100) - cfg.txCostUsd;

  return {
    ...base,
    outcome: pnlUsd >= 0 ? "win" : "loss",
    executedGrossPct: round4(grossPct),
    decayPct: round4(attempt.grossPct - grossPct), // how much edge latency ate
    pnlUsd: round4(pnlUsd),
  };
}

/* ================================================================
   Ledger
   ================================================================ */

export function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { startedAt: new Date().toISOString(), trades: [] };
  try { return JSON.parse(readFileSync(LEDGER_PATH, "utf8")); }
  catch { return { startedAt: new Date().toISOString(), trades: [] }; }
}

export function saveLedger(ledger) {
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

export function ledgerStats(ledger) {
  const t = ledger.trades;
  const sum = k => round4(t.reduce((s, x) => s + (x[k] || 0), 0));
  const count = o => t.filter(x => x.outcome === o).length;
  return {
    attempts: t.length,
    wins: count("win"),
    losses: count("loss"),
    noLands: count("no-land"),
    feesPaidUsd: sum("feesUsd"),
    netPnlUsd: sum("pnlUsd"),
  };
}

export function printStats(ledger) {
  const s = ledgerStats(ledger);
  console.log("\n📒 Paper ledger — since " + (ledger.startedAt || "?"));
  console.log(`   attempts: ${s.attempts}   landed+won: ${s.wins}   landed+lost: ${s.losses}   lost race: ${s.noLands}`);
  console.log(`   fees paid: $${s.feesPaidUsd.toFixed(2)}   NET P&L: ${s.netPnlUsd >= 0 ? "+" : ""}$${s.netPnlUsd.toFixed(2)}`);
  if (s.attempts && s.netPnlUsd < 0) {
    console.log("   (negative after fees — this is the normal outcome; see README)");
  }
}

/* ================================================================
   Main loop
   ================================================================ */

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

export function parseArgs(argv) {
  const flag = name => {
    const i = argv.indexOf("--" + name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    once: argv.includes("--once"),
    stats: argv.includes("--stats"),
    reset: argv.includes("--reset"),
    intervalMs: Number(flag("interval")) || DEFAULTS.intervalMs,
    maxTradeUsd: Number(flag("size")) || DEFAULTS.maxTradeUsd,
    minNetEdgePct: flag("min-edge") != null ? Number(flag("min-edge")) : DEFAULTS.minNetEdgePct,
    landRatePct: flag("land-rate") != null ? Number(flag("land-rate")) : DEFAULTS.landRatePct,
    tokens: flag("tokens") ? flag("tokens").split(",").map(s => s.trim()).filter(Boolean) : DEFAULT_TOKENS,
  };
}

async function scanOnce(cfg, pending, ledger, fetchFn = fetch) {
  const pairs = await fetchPools(cfg.tokens, fetchFn);
  const byToken = usablePoolsByToken(pairs, cfg);
  const stamp = new Date().toISOString().slice(11, 19);

  // 1) settle attempts queued last poll at THIS poll's prices
  for (const attempt of pending.splice(0)) {
    const result = settleAttempt(attempt, byToken, cfg);
    ledger.trades.push(result);
    const tag = result.outcome === "win" ? "✅ WIN " : result.outcome === "loss" ? "❌ LOSS" : "🏃 NO-LAND";
    const decay = result.decayPct != null ? `  (latency ate ${result.decayPct.toFixed(3)}% of edge)` : "";
    console.log(`[${stamp}] ${tag} ${result.symbol} $${result.sizeUsd}: ${result.pnlUsd >= 0 ? "+" : ""}$${result.pnlUsd.toFixed(4)}${decay}${result.note ? " — " + result.note : ""}`);
  }
  saveLedger(ledger);

  // 2) look for new opportunities and queue attempts for next poll
  const opps = findOpportunities(byToken, cfg);
  const tokensScanned = Object.keys(byToken).length;
  const best = opps[0];
  if (!best) {
    console.log(`[${stamp}] scanned ${tokensScanned} multi-pool tokens — no spreads found`);
    return;
  }
  if (best.netPct < cfg.minNetEdgePct) {
    console.log(`[${stamp}] scanned ${tokensScanned} tokens — best: ${best.symbol} ` +
      `${best.buy.dex}→${best.sell.dex} gross ${best.grossPct.toFixed(3)}%, ` +
      `net ${best.netPct.toFixed(3)}% after costs (below ${cfg.minNetEdgePct}% threshold)`);
    return;
  }
  pending.push({ ...best, detectedAt: new Date().toISOString() });
  console.log(`[${stamp}] 🎯 ATTEMPT ${best.symbol}: buy ${best.buy.dex} @ ${best.buy.price} → ` +
    `sell ${best.sell.dex} @ ${best.sell.price} | size $${best.sizeUsd} | ` +
    `net edge ${best.netPct.toFixed(3)}% — filling at NEXT poll's prices…`);
}

export async function main(argv = process.argv.slice(2)) {
  const cfg = { ...DEFAULTS, ...parseArgs(argv) };

  if (cfg.reset) {
    if (existsSync(LEDGER_PATH)) unlinkSync(LEDGER_PATH);
    console.log("Paper ledger wiped.");
    return;
  }
  if (cfg.stats) {
    printStats(loadLedger());
    return;
  }

  const ledger = loadLedger();
  const pending = [];
  console.log(`🥷 Paper MEV bot — ${cfg.tokens.length} tokens, poll ${cfg.intervalMs}ms, ` +
    `size ≤$${cfg.maxTradeUsd}, min net edge ${cfg.minNetEdgePct}%, land rate ${cfg.landRatePct}%`);
  console.log("   Paper trading only — no wallet, no real transactions. Ctrl-C to stop.\n");

  await scanOnce(cfg, pending, ledger);
  if (cfg.once) { printStats(ledger); return; }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(r => setTimeout(r, cfg.intervalMs));
    try { await scanOnce(cfg, pending, ledger); }
    catch (err) { console.error("scan failed:", err.message || err); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("SIGINT", () => { printStats(loadLedger()); process.exit(0); });
  main().catch(err => { console.error(err); process.exit(1); });
}
