// Patty Prix — Solana smart-money / whale tracker.
//
// Discovers whale wallets you DON'T already know, ranks them by how good their
// trading actually is (realized PnL + win rate, not just position size), and
// shows what they're currently buying. Everything here is public on-chain data
// — pseudonymous wallet addresses and their swaps. It tracks wallets; it makes
// no attempt to tie a wallet to a real-world identity.
//
// Pipeline:
//   1. TRENDING   Birdeye's trending tokens → today's active markets
//   2. CANDIDATES top holders of each (Helius getTokenAccounts) → whale suspects
//   3. SCORE      each suspect's swap history (Helius enhanced txs) → realized
//                 PnL and win rate, reconstructed with average-cost basis
//   4. TRACK      the smart-money wallets' most recent buys
//
// Needs two env vars (same keys api/stats.mjs already uses):
//   HELIUS_API_KEY   — ledger data (holders + per-wallet swap history)
//   BIRDEYE_API_KEY  — trending list + SOL price for USD valuation
//
// Usage:
//   node scripts/whale-tracker.mjs                       # full run, defaults
//   node scripts/whale-tracker.mjs --trending 15 --candidates 40 --limit 20
//   node scripts/whale-tracker.mjs --min-pnl 10000 --min-winrate 55 --min-trades 8
//
// NOTE: this must run where it can reach Helius/Birdeye (your machine or Vercel).
// It will not run inside a network-restricted sandbox.

import { pathToFileURL } from "url";

/* ================================================================
   Quote assets — the "cash" side of a trade, used to value swaps
   ================================================================ */

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const QUOTE_MINTS = new Set([WSOL, USDC, USDT]);

// USD value of a quote leg. Stablecoins ≈ $1; SOL uses a supplied price.
export function quoteUsd(mint, uiAmount, solPriceUsd) {
  if (mint === USDC || mint === USDT) return uiAmount;
  if (mint === WSOL) return uiAmount * solPriceUsd;
  return 0;
}

/* ================================================================
   Swap parsing — turn a Helius enhanced tx into a typed trade
   ================================================================ */

// Normalize the two sides of a Helius `events.swap` into {mint, ui} legs.
// nativeInput/nativeOutput are lamports (SOL, 9 decimals); tokenInputs/
// tokenOutputs carry rawTokenAmount { tokenAmount, decimals }.
function legs(side) {
  const out = [];
  if (!side) return out;
  const native = side.native;
  if (native && native.amount) out.push({ mint: WSOL, ui: Number(native.amount) / 1e9 });
  for (const t of side.tokens || []) {
    const raw = t.rawTokenAmount || {};
    const dec = Number(raw.decimals || 0);
    const ui = Number(raw.tokenAmount || 0) / Math.pow(10, dec);
    if (t.mint && ui) out.push({ mint: t.mint, ui });
  }
  return out;
}

// Classify a swap from the perspective of `wallet`:
//   received a non-quote token, paid quote      → BUY
//   gave a non-quote token, received quote       → SELL
//   token↔token or quote↔quote                   → null (can't value cleanly)
export function parseSwap(tx, solPriceUsd) {
  const sw = tx?.events?.swap;
  if (!sw) return null;
  const inputs = legs({ native: sw.nativeInput, tokens: sw.tokenInputs });   // wallet gave
  const outputs = legs({ native: sw.nativeOutput, tokens: sw.tokenOutputs }); // wallet got

  const nonQuote = arr => arr.find(l => !QUOTE_MINTS.has(l.mint));
  const quoteSum = arr =>
    arr.filter(l => QUOTE_MINTS.has(l.mint))
       .reduce((s, l) => s + quoteUsd(l.mint, l.ui, solPriceUsd), 0);

  const boughtTok = nonQuote(outputs);
  const soldTok = nonQuote(inputs);
  const ts = tx.timestamp || 0;

  if (boughtTok && !nonQuote(inputs)) {
    const cost = quoteSum(inputs);
    if (!cost) return null;
    return { side: "buy", mint: boughtTok.mint, tokenAmount: boughtTok.ui, quoteUsd: cost, timestamp: ts };
  }
  if (soldTok && !nonQuote(outputs)) {
    const proceeds = quoteSum(outputs);
    if (!proceeds) return null;
    return { side: "sell", mint: soldTok.mint, tokenAmount: soldTok.ui, quoteUsd: proceeds, timestamp: ts };
  }
  return null; // token-to-token or pure quote swap
}

/* ================================================================
   Per-wallet PnL & win rate (average-cost basis)
   ================================================================ */

// Reconstruct realized PnL by walking trades oldest→newest, keeping an
// average-cost position per token. A sell realizes (proceeds − avgCost×sold).
// Win rate = share of closing sells that came out ahead. Buys with no later
// sell stay unrealized (not counted); sells with no known cost basis (bought
// before our history window) are skipped so they can't fake a win or loss.
export function computeWalletPnL(trades) {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const pos = new Map(); // mint → { tokens, costUsd }
  let realizedUsd = 0, wins = 0, closes = 0;
  const buys = [];

  for (const t of sorted) {
    if (t.side === "buy") {
      const p = pos.get(t.mint) || { tokens: 0, costUsd: 0 };
      p.tokens += t.tokenAmount;
      p.costUsd += t.quoteUsd;
      pos.set(t.mint, p);
      buys.push(t);
    } else if (t.side === "sell") {
      const p = pos.get(t.mint);
      if (!p || p.tokens <= 0) continue; // no basis on record → skip
      const avg = p.costUsd / p.tokens;
      const sold = Math.min(t.tokenAmount, p.tokens);
      const costPortion = avg * sold;
      const proceeds = t.quoteUsd * (sold / t.tokenAmount);
      const pnl = proceeds - costPortion;
      realizedUsd += pnl;
      closes += 1;
      if (pnl > 0) wins += 1;
      p.tokens -= sold;
      p.costUsd -= costPortion;
    }
  }

  return {
    realizedUsd,
    winRate: closes ? wins / closes : null,
    closedTrades: closes,
    openPositions: [...pos.values()].filter(p => p.tokens > 1e-9).length,
    recentBuys: buys.sort((a, b) => b.timestamp - a.timestamp),
  };
}

// Does a scored wallet clear the "smart money" bar?
export function isSmartMoney(stats, cfg) {
  return (
    stats.closedTrades >= cfg.minTrades &&
    stats.realizedUsd >= cfg.minPnlUsd &&
    stats.winRate != null &&
    stats.winRate * 100 >= cfg.minWinRatePct
  );
}

/* ================================================================
   Discovery helpers (pure — operate on already-fetched JSON)
   ================================================================ */

// getTokenAccounts pages → owner→balance map (sum token accounts per owner).
export function ownersFromTokenAccounts(pages) {
  const owners = new Map();
  for (const page of pages) {
    for (const acct of page?.result?.token_accounts || page?.token_accounts || []) {
      const owner = acct.owner;
      const amt = Number(acct.amount || 0);
      if (!owner) continue;
      owners.set(owner, (owners.get(owner) || 0) + amt);
    }
  }
  return owners;
}

export function topOwners(ownerMap, n) {
  return [...ownerMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([o]) => o);
}

export function parseTrending(json, limit) {
  const items = json?.data?.tokens || json?.data?.items || [];
  return items.slice(0, limit).map(t => ({
    address: t.address,
    symbol: t.symbol || (t.address ? t.address.slice(0, 4) : "?"),
  })).filter(t => t.address);
}

/* ================================================================
   Live data layer (Helius + Birdeye). Injectable fetch for tests.
   ================================================================ */

export function makeClient(env, fetchFn = fetch) {
  const helius = env.HELIUS_API_KEY;
  const birdeye = env.BIRDEYE_API_KEY;

  const rpc = async (method, params) => {
    const r = await fetchFn("https://mainnet.helius-rpc.com/?api-key=" + helius, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return r.json();
  };

  const bird = async (path) => {
    const r = await fetchFn("https://public-api.birdeye.so" + path, {
      headers: { "X-API-KEY": birdeye, "x-chain": "solana", accept: "application/json" },
    });
    return r.json();
  };

  return {
    async trending(limit) {
      const json = await bird(`/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=${limit}`);
      return parseTrending(json, limit);
    },
    async solPrice() {
      const json = await bird(`/defi/price?address=${WSOL}`);
      return Number(json?.data?.value) || 0;
    },
    async topHolders(mint, pages, perTokenCandidates) {
      const fetched = [];
      for (let p = 1; p <= pages; p++) {
        fetched.push(await rpc("getTokenAccounts", { mint, limit: 1000, page: p }));
      }
      return topOwners(ownersFromTokenAccounts(fetched), perTokenCandidates);
    },
    async walletSwaps(wallet, pages) {
      const txs = [];
      let before = "";
      for (let i = 0; i < pages; i++) {
        const url = "https://api.helius.xyz/v0/addresses/" + wallet +
          "/transactions?api-key=" + helius + "&type=SWAP&limit=100" + (before ? "&before=" + before : "");
        const r = await fetchFn(url);
        const batch = await r.json();
        if (!Array.isArray(batch) || !batch.length) break;
        txs.push(...batch);
        before = batch[batch.length - 1]?.signature || "";
        if (!before) break;
      }
      return txs;
    },
  };
}

/* ================================================================
   Orchestration
   ================================================================ */

export async function discoverSmartMoney(cfg, client, log = () => {}) {
  const solPriceUsd = cfg.solPriceUsd || (await client.solPrice()) || 150;

  log(`① trending: fetching ${cfg.trending} tokens…`);
  const tokens = await client.trending(cfg.trending);
  const symbolByMint = new Map(tokens.map(t => [t.address, t.symbol]));

  log(`② candidates: top ${cfg.perToken} holders of each…`);
  const candidates = new Set();
  for (const t of tokens) {
    const owners = await client.topHolders(t.address, cfg.holderPages, cfg.perToken);
    owners.forEach(o => candidates.add(o));
  }
  const wallets = [...candidates].slice(0, cfg.maxCandidates);
  log(`   ${wallets.length} unique whale suspects to score`);

  log(`③ scoring: reconstructing PnL from swap history…`);
  const scored = [];
  for (const w of wallets) {
    const raw = await client.walletSwaps(w, cfg.swapPages);
    const trades = raw.map(tx => parseSwap(tx, solPriceUsd)).filter(Boolean);
    const stats = computeWalletPnL(trades);
    scored.push({ wallet: w, ...stats });
  }

  const smart = scored
    .filter(s => isSmartMoney(s, cfg))
    .sort((a, b) => b.realizedUsd - a.realizedUsd)
    .slice(0, cfg.limit);

  log(`④ ${smart.length} wallets cleared the smart-money bar`);
  return { smart, scannedTokens: tokens.length, scoredWallets: scored.length, symbolByMint, solPriceUsd };
}

/* ================================================================
   Presentation + CLI
   ================================================================ */

function usd(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? (n / 1e6).toFixed(2) + "M" : a >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(0);
  return (n < 0 ? "-$" : "$") + s.replace("-", "");
}
function shortMint(m) { return m.slice(0, 4) + "…" + m.slice(-4); }
function ago(ts) {
  if (!ts) return "?";
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 3600) return Math.floor(secs / 60) + "m";
  if (secs < 86400) return Math.floor(secs / 3600) + "h";
  return Math.floor(secs / 86400) + "d";
}

export function render(result) {
  const { smart, scannedTokens, scoredWallets, symbolByMint } = result;
  const L = [];
  L.push("🐋 SOLANA SMART-MONEY TRACKER");
  L.push(`   scanned ${scannedTokens} trending tokens · scored ${scoredWallets} wallets · SOL @ ${usd(result.solPriceUsd)}`);
  L.push("");
  if (!smart.length) {
    L.push("No wallets cleared the filters. Loosen --min-pnl / --min-winrate / --min-trades.");
    return L.join("\n");
  }
  smart.forEach((s, i) => {
    L.push(`${String(i + 1).padStart(2)}. ${shortMint(s.wallet)}   ` +
      `PnL ${usd(s.realizedUsd).padStart(8)} · win ${(s.winRate * 100).toFixed(0)}% · ${s.closedTrades} closed · ${s.openPositions} open`);
    const buys = s.recentBuys.slice(0, 3);
    if (buys.length) {
      const parts = buys.map(b => {
        const sym = symbolByMint.get(b.mint) || shortMint(b.mint);
        return `${sym} ${usd(b.quoteUsd)} (${ago(b.timestamp)} ago)`;
      });
      L.push(`     buying: ${parts.join("  ·  ")}`);
    }
  });
  L.push("");
  L.push("Full wallet addresses are in the JSON output (--json). Public data only.");
  return L.join("\n");
}

export function parseArgs(argv) {
  const flag = n => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (n, d) => (flag(n) != null ? Number(flag(n)) : d);
  return {
    trending: num("trending", 10),
    holderPages: num("holder-pages", 1),
    perToken: num("per-token", 20),
    maxCandidates: num("candidates", 60),
    swapPages: num("swap-pages", 2),
    minPnlUsd: num("min-pnl", 5000),
    minWinRatePct: num("min-winrate", 50),
    minTrades: num("min-trades", 5),
    limit: num("limit", 20),
    solPriceUsd: flag("sol-price") != null ? Number(flag("sol-price")) : 0,
    json: argv.includes("--json"),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchFn = fetch) {
  const cfg = parseArgs(argv);
  if (!env.HELIUS_API_KEY || !env.BIRDEYE_API_KEY) {
    console.error("Set HELIUS_API_KEY and BIRDEYE_API_KEY (this needs live network access — run it locally or on Vercel, not in a restricted sandbox).");
    process.exit(1);
  }
  const client = makeClient(env, fetchFn);
  const result = await discoverSmartMoney(cfg, client, msg => console.error(msg));
  if (cfg.json) {
    console.log(JSON.stringify(result.smart, null, 2));
  } else {
    console.log("\n" + render(result) + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
