// Patty Prix — sandwich-attack SIMULATOR (paper-only, offline).
//
// A sandwich is the predatory MEV strategy the "subway never closes 🥪" thread
// was romanticizing. This models it end-to-end with constant-product (Uniswap-
// v2 / Raydium-style) AMM math so you can see the ACTUAL economics the thread
// leaves out — including who pays for the attacker's profit (the victim) and how
// much of that profit evaporates to gas, tips, and lost races.
//
// This is a calculator, NOT a bot. It never touches a mempool, an RPC, a wallet,
// or the chain. It takes a HYPOTHETICAL victim swap you describe and computes
// what a sandwich would do to it. There is deliberately no transaction-
// submission code here — the live version of this is a tool for extracting money
// from strangers, and this repo won't ship one.
//
// Usage:
//   node scripts/sandwich-simulator.mjs                 # default ETH-style example
//   node scripts/sandwich-simulator.mjs --chain solana  # Solana-style fee preset
//   node scripts/sandwich-simulator.mjs --sweep         # show how victim slippage
//                                                       #   tolerance changes everything
//
// Options (all optional):
//   --chain <eth|solana>   fee/cost preset, default eth
//   --liq <usd>            pool liquidity (total USD both sides), default 500000
//   --victim <usd>         victim's buy size in USD, default 5000
//   --slippage <pct>       victim's slippage tolerance, default 1.0
//   --fee <pct>            pool swap fee per leg, default 0.30 (eth) / 0.25 (solana)
//   --gas <usd>            attacker cost per landed bundle (gas or priority+tip)
//   --land-rate <pct>      chance the attacker wins the race, default 50
//
// Everything is a paper number. Nothing here executes.

import { pathToFileURL } from "url";

/* ================================================================
   Constant-product AMM primitives (x * y = k, fee on input)
   ================================================================ */

// Buy `base` tokens by spending `quoteIn` of the quote asset.
// Returns { tokensOut, pool: next reserves }. Fee stays in the pool.
export function buy(pool, quoteIn, feePct) {
  const feeMul = 1 - feePct / 100;
  const inEff = quoteIn * feeMul;
  const tokensOut = (pool.base * inEff) / (pool.quote + inEff);
  return {
    tokensOut,
    pool: { base: pool.base - tokensOut, quote: pool.quote + quoteIn },
  };
}

// Sell `tokensIn` base tokens back for quote. Returns { quoteOut, pool }.
export function sell(pool, tokensIn, feePct) {
  const feeMul = 1 - feePct / 100;
  const inEff = tokensIn * feeMul;
  const quoteOut = (pool.quote * inEff) / (pool.base + inEff);
  return {
    quoteOut,
    pool: { base: pool.base + tokensIn, quote: pool.quote - quoteOut },
  };
}

export function price(pool) { return pool.quote / pool.base; }

/* ================================================================
   The sandwich
   ================================================================ */

// Simulate one sandwich at a chosen frontrun size.
//
// Sequence in the attacker's bundle:
//   1. attacker frontruns: buys with `frontrunUsd`, pushing the price UP
//   2. victim's buy executes at the now-worse price
//   3. attacker backruns: sells the tokens from step 1 into the richer pool
//
// The victim set minOut from the price they SAW (pre-sandwich). If the attacker
// pushes the price so far that the victim would receive less than minOut, the
// victim's transaction reverts — and the sandwich fails (no step 2, no profit,
// attacker just round-trips and eats fees). That revert threshold is the single
// biggest constraint on how much an attacker can take, which is exactly why
// "use tighter slippage" is real advice.
export function simulateSandwich(pool0, victimUsd, slippagePct, frontrunUsd, feePct) {
  // What the victim expected on the untouched pool.
  const victimQuoteBase = victimUsd; // treat USD as the quote unit for clarity
  const expected = buy(pool0, victimQuoteBase, feePct).tokensOut;
  const minOut = expected * (1 - slippagePct / 100);

  // 1. frontrun
  const fr = buy(pool0, frontrunUsd, feePct);
  const tokensBought = fr.tokensOut;

  // 2. victim buys into the pushed pool
  const vic = buy(fr.pool, victimQuoteBase, feePct);
  const victimGot = vic.tokensOut;

  if (victimGot < minOut) {
    // Victim tx reverts. Attacker is stuck holding `tokensBought`; unwinding it
    // just pays fees both ways. Model the round-trip loss (no victim in middle).
    const unwind = sell(fr.pool, tokensBought, feePct).quoteOut;
    return {
      reverted: true,
      frontrunUsd,
      grossProfitUsd: unwind - frontrunUsd, // negative: the fee round-trip
      victimLossUsd: 0,
      victimGot: expected,
      victimExpected: expected,
    };
  }

  // 3. backrun: sell the frontrun tokens into the pool the victim just enriched
  const br = sell(vic.pool, tokensBought, feePct);
  const grossProfitUsd = br.quoteOut - frontrunUsd;

  // Victim harm measured in USD: the extra quote value of tokens they lost,
  // priced at the untouched pool price.
  const victimLossUsd = (expected - victimGot) * price(pool0);

  return {
    reverted: false,
    frontrunUsd,
    grossProfitUsd,
    victimLossUsd,
    victimGot,
    victimExpected: expected,
  };
}

// Search frontrun sizes for the one that maximizes attacker gross profit while
// keeping the victim just under their revert threshold. Coarse scan → refine.
export function optimalSandwich(pool0, victimUsd, slippagePct, feePct) {
  const liqQuote = pool0.quote;
  let best = { grossProfitUsd: -Infinity, frontrunUsd: 0, reverted: true };

  const scan = (lo, hi, steps) => {
    for (let i = 1; i <= steps; i++) {
      const f = lo + ((hi - lo) * i) / steps;
      const r = simulateSandwich(pool0, victimUsd, slippagePct, f, feePct);
      if (!r.reverted && r.grossProfitUsd > best.grossProfitUsd) best = r;
    }
  };

  // Frontrun rarely usefully exceeds a few multiples of the victim size or a
  // slice of the pool; bound the search there.
  const hi = Math.min(liqQuote * 0.5, victimUsd * 20 + 1);
  scan(0, hi, 400);
  if (best.frontrunUsd > 0) {
    const span = hi / 400;
    scan(Math.max(0, best.frontrunUsd - span), best.frontrunUsd + span, 200);
  }
  return best;
}

/* ================================================================
   Costs, competition, and expected value
   ================================================================ */

export const CHAIN_PRESETS = {
  eth: { feePct: 0.30, gasUsd: 12, label: "Ethereum (gas per landed bundle)" },
  solana: { feePct: 0.25, gasUsd: 1.2, label: "Solana (priority fee + Jito tip per attempt)" },
};

// Turn a gross sandwich into a realistic expected value. Key facts the thread
// skips: you pay to PLAY, not to win — a lost race still costs the tip/gas — and
// competing searchers bid the profit down. `landRatePct` is your win odds.
export function expectedValue(gross, costUsd, landRatePct) {
  const p = landRatePct / 100;
  // Win: keep gross, pay cost. Lose the race: pay cost, get nothing (someone
  // else landed the sandwich, or your bundle was dropped).
  const evWin = gross - costUsd;
  const evLose = -costUsd;
  return {
    netIfLandUsd: evWin,
    expectedUsd: p * evWin + (1 - p) * evLose,
    breakevenLandRatePct: gross > 0 ? (costUsd / gross) * 100 : Infinity,
  };
}

/* ================================================================
   Presentation
   ================================================================ */

function usd(n) {
  const s = Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
  return (n < 0 ? "-$" : "$") + s.replace("-", "");
}
function pct(n) { return (n >= 0 ? "" : "") + n.toFixed(2) + "%"; }

export function poolFromLiq(liqUsd, priceUsd = 1) {
  // Split liquidity 50/50; quote side is USD, base side is tokens at `priceUsd`.
  const quote = liqUsd / 2;
  const base = quote / priceUsd;
  return { base, quote };
}

export function report(cfg) {
  const preset = CHAIN_PRESETS[cfg.chain] || CHAIN_PRESETS.eth;
  const feePct = cfg.fee != null ? cfg.fee : preset.feePct;
  const gasUsd = cfg.gas != null ? cfg.gas : preset.gasUsd;
  const pool0 = poolFromLiq(cfg.liq);

  const best = optimalSandwich(pool0, cfg.victim, cfg.slippage, feePct);
  const lines = [];
  lines.push("🥪 SANDWICH SIMULATOR — paper only, nothing executes\n");
  lines.push(`Chain preset : ${preset.label}`);
  lines.push(`Pool         : ${usd(cfg.liq)} liquidity, ${feePct}% swap fee/leg`);
  lines.push(`Victim       : ${usd(cfg.victim)} buy, ${cfg.slippage}% slippage tolerance`);
  lines.push(`Attacker cost: ${usd(gasUsd)} per attempt (${cfg.chain === "solana" ? "priority+tip" : "gas"}), lands ${cfg.landRate}% of races\n`);

  if (best.grossProfitUsd <= 0 || best.frontrunUsd === 0) {
    lines.push("Result: no profitable sandwich exists here.");
    lines.push("The victim's slippage tolerance is too tight to extract from at this");
    lines.push("size — the frontrun that would profit also trips the victim's revert.");
    lines.push("\nThat is the whole defense: tight slippage on a liquid pool starves the");
    lines.push("attack before costs even enter the picture.");
    return lines.join("\n");
  }

  const ev = expectedValue(best.grossProfitUsd, gasUsd, cfg.landRate);
  lines.push(`Optimal frontrun : ${usd(best.frontrunUsd)}`);
  lines.push(`Victim overpays  : ${usd(best.victimLossUsd)}  ← this is where the profit comes from`);
  lines.push(`Attacker gross   : ${usd(best.grossProfitUsd)}`);
  lines.push(`  − cost if won  : ${usd(gasUsd)}`);
  lines.push(`  = net if landed: ${usd(ev.netIfLandUsd)}`);
  lines.push("");
  lines.push(`Break-even land rate: ${ev.breakevenLandRatePct.toFixed(1)}%  (below this, you lose money on average)`);
  lines.push(`Expected value/attempt @ ${cfg.landRate}% land rate: ${usd(ev.expectedUsd)}`);
  lines.push("");
  if (ev.expectedUsd < 0) {
    lines.push("→ NEGATIVE expected value. At this win rate the tips you burn losing");
    lines.push("  races outweigh the take when you win. This is the reality the thread");
    lines.push("  omits: 'subway never closes' also means you pay rent every attempt.");
  } else {
    lines.push("→ Positive on paper — but this assumes you actually hit the land rate.");
    lines.push("  Against pro searchers with better infra, your real land rate on public");
    lines.push("  orderflow is far lower than you'd guess, which drags EV back down.");
  }
  lines.push("\nWho paid for the attacker's profit? The victim, entirely. Nothing here");
  lines.push("'tightened spreads' or 'helped retail' — it's a transfer, minus rent to");
  lines.push("validators. That's the part the 🥪 thread was selling around.");
  return lines.join("\n");
}

export function sweep(cfg) {
  const preset = CHAIN_PRESETS[cfg.chain] || CHAIN_PRESETS.eth;
  const feePct = cfg.fee != null ? cfg.fee : preset.feePct;
  const gasUsd = cfg.gas != null ? cfg.gas : preset.gasUsd;
  const pool0 = poolFromLiq(cfg.liq);

  const lines = [];
  lines.push("🥪 SLIPPAGE SWEEP — how the victim's own setting controls their fate\n");
  lines.push(`Pool ${usd(cfg.liq)} · victim ${usd(cfg.victim)} · ${preset.label}\n`);
  lines.push("slippage │ victim overpays │ attacker gross │ net if landed");
  lines.push("─────────┼────────────────┼────────────────┼──────────────");
  for (const s of [0.1, 0.5, 1, 2, 3, 5, 10]) {
    const b = optimalSandwich(pool0, cfg.victim, s, feePct);
    if (b.grossProfitUsd <= 0 || b.frontrunUsd === 0) {
      lines.push(`  ${String(s).padStart(4)}%  │      —         │      —         │  no attack`);
    } else {
      const net = b.grossProfitUsd - gasUsd;
      lines.push(
        `  ${String(s).padStart(4)}%  │  ${usd(b.victimLossUsd).padStart(12)}  │  ${usd(b.grossProfitUsd).padStart(12)}  │  ${usd(net).padStart(11)}`
      );
    }
  }
  lines.push("\nTighter slippage = smaller (or zero) sandwich. The victim controls this.");
  return lines.join("\n");
}

/* ================================================================
   CLI
   ================================================================ */

export function parseArgs(argv) {
  const flag = name => {
    const i = argv.indexOf("--" + name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = flag("chain") || "eth";
  const preset = CHAIN_PRESETS[chain] || CHAIN_PRESETS.eth;
  return {
    chain,
    liq: Number(flag("liq")) || 500_000,
    victim: Number(flag("victim")) || 5_000,
    slippage: flag("slippage") != null ? Number(flag("slippage")) : 1.0,
    fee: flag("fee") != null ? Number(flag("fee")) : undefined,
    gas: flag("gas") != null ? Number(flag("gas")) : undefined,
    landRate: flag("land-rate") != null ? Number(flag("land-rate")) : 50,
    doSweep: argv.includes("--sweep"),
    _presetFee: preset.feePct,
  };
}

export function main(argv = process.argv.slice(2)) {
  const cfg = parseArgs(argv);
  console.log("\n" + (cfg.doSweep ? sweep(cfg) : report(cfg)) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
