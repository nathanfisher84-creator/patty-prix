// Rug or Moon — live liquidity-watch Telegram bot (monitor + alert only).
//
// An always-on process that watches a list of Solana tokens and DMs you on
// Telegram the moment liquidity starts draining (or safety drops / smart money
// exits / a new red flag / the "cut supply on the pump" pattern). It reuses the
// tested Rug or Moon engine — scanToken() for the data, diffScan() for the
// change detection — so the risky logic is already verified; this file is the
// loop + Telegram glue.
//
// It is MONITOR-ONLY: it never holds keys, funds, or places trades.
//
// Because it's a long-running process it keeps the previous scan of each token
// IN MEMORY, so there's no database — a restart just re-establishes the baseline
// (no alerts on the first pass). Watchlist persists to a JSON file.
//
// Env:
//   HELIUS_API_KEY      — powers authority/holder checks (recommended)
//   TELEGRAM_BOT_TOKEN  — from @BotFather (required)
//   TELEGRAM_CHAT_ID    — your chat/user id; the bot only obeys this id (required)
//   BIRDEYE_API_KEY     — optional, improves data
//   WATCH_TOKENS        — optional comma-separated mints to seed the watchlist
//   POLL_SECONDS        — how often to re-check (default 60)
//   LIQ_DROP_PCT        — alert when liquidity falls this % between checks (default 15)
//   WATCHLIST_FILE      — where the watchlist persists (default ./liquidity-watchlist.json)
//
// Telegram commands (only from TELEGRAM_CHAT_ID): /watch <mint> /unwatch <mint>
//   /list  /scan <mint>  /help
//
// Run:  node scripts/liquidity-bot.mjs   (deploy on an always-on host — see LIQUIDITY-BOT.md)

import { readFileSync, writeFileSync, existsSync } from "fs";
import { pathToFileURL } from "url";
import { scanToken, findDeployer } from "../rug-or-moon/api/scan.mjs";
import { scanTrending } from "../rug-or-moon/api/trending.mjs";
import { diffScan } from "../rug-or-moon/watchlist.mjs";
import { parseSmartMoney } from "../rug-or-moon/smart-money.mjs";
import { sendTelegram } from "./whale-alerts.mjs";
import { discoverSmartMoney, makeClient, parseSwap, ownersFromTokenAccounts } from "./whale-tracker.mjs";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= pure, testable logic ================= */

// Turn a scanToken() result into the compact shape diffScan expects (mirrors the
// PWA's snapshot). Prefers Meteora's native quote reserve for the drain signal.
export function buildSnapshot(d, token) {
  return {
    token,
    symbol: d.market?.symbol || null,
    safety: d.safety, tier: d.tier,
    smartMoneyHolders: d.smartMoneyHolders ?? 0,
    smartMoneyReliable: !!d.smartMoneyReliable,
    dataComplete: d.dataComplete !== false,
    priceUsd: d.market?.priceUsd ?? null,
    priceChange24h: d.market?.priceChange24h ?? null,
    liqQuote: d.market?.meteoraQuote ?? d.market?.liqQuote ?? null,
    liquidityUsd: d.market?.liquidityUsd ?? null,
    volume24h: d.market?.volume24h ?? null,
    holders: d.holders ?? null,
    topHolders: d.topHolders || [],
    lpLockedPct: d.lpLockedPct ?? null,
    dexId: d.market?.dexId || null,
    flags: (d.flags || []).filter(f => f.level === "red").map(f => ({ level: "red", id: f.id, text: f.text })),
  };
}

// The core ask: plain "liquidity is going down". Uses the SOL/quote reserve when
// available (immune to price moves); falls back to USD liquidity otherwise.
export function liquidityDrop(prev, curr, dropPct = 15) {
  if (!prev || !curr) return null;
  const usingQuote = prev.liqQuote != null && curr.liqQuote != null;
  const p = usingQuote ? prev.liqQuote : prev.liquidityUsd;
  const c = usingQuote ? curr.liqQuote : curr.liquidityUsd;
  if (!(p > 0) || c == null || c < 0) return null;
  const drop = (1 - c / p) * 100;
  if (drop >= dropPct) {
    return { level: "red", kind: "liquidity-drop", text: `Liquidity dropping — ${usingQuote ? "pool SOL" : "liquidity"} −${Math.round(drop)}%` };
  }
  return null;
}

// All alerts for a token between two scans: the plain drop + everything diffScan
// already detects (pump-drain, safety drop, tier down, smart-money exit, new red
// flag). A plain drop is suppressed when the richer "pull on pump" already fired.
export function alertsFor(prev, curr, dropPct = 15) {
  const alerts = diffScan(prev, curr);
  const drop = liquidityDrop(prev, curr, dropPct);
  if (drop && !alerts.some(a => a.kind === "liq-pull-on-pump")) alerts.unshift(drop);
  return alerts;
}

// Slow-moving trends (volume, holders) — compared against a BASELINE snapshot
// taken a while ago (not the 60s-ago one, where a 24h figure barely moves).
export function trendAlerts(baseline, curr, cfg = {}) {
  const out = [];
  if (!baseline) return out;
  const volDrop = cfg.volDropPct ?? 40, holderDrop = cfg.holderDropPct ?? 10;
  if (baseline.volume24h > 0 && curr.volume24h != null) {
    const d = (1 - curr.volume24h / baseline.volume24h) * 100;
    if (d >= volDrop) out.push({ level: "yellow", kind: "volume-fade", text: `Volume fading — 24h volume −${Math.round(d)}% (interest cooling)` });
  }
  if (baseline.holders > 0 && curr.holders != null) {
    const d = (1 - curr.holders / baseline.holders) * 100;
    if (d >= holderDrop) out.push({ level: "red", kind: "holders-drop", text: `Holders leaving — −${Math.round(d)}% (${baseline.holders} → ${curr.holders})` });
  }
  return out;
}

// The POSITIVE side — "setup improving" alerts vs the baseline. LP getting locked,
// holders growing fast, or the safety tier upgrading. Still NFA, never a buy call
// (smart-money-entering is already covered by diffScan's smart-money-in).
const TIER_RANK = { "high-risk": 0, caution: 1, clean: 2 };
export function improvementAlerts(baseline, curr, cfg = {}) {
  const out = [];
  if (!baseline) return out;
  if (baseline.lpLockedPct != null && baseline.lpLockedPct < 90 && curr.lpLockedPct != null && curr.lpLockedPct >= 90)
    out.push({ level: "green", kind: "lp-locked", text: `Liquidity just locked/burned (${Math.round(curr.lpLockedPct)}%)` });
  if (baseline.holders > 0 && curr.holders != null) {
    const g = (curr.holders / baseline.holders - 1) * 100;
    if (g >= (cfg.holderGrowPct ?? 25)) out.push({ level: "green", kind: "holders-grow", text: `Holders +${Math.round(g)}% (${baseline.holders} → ${curr.holders})` });
  }
  if (TIER_RANK[curr.tier] != null && TIER_RANK[baseline.tier] != null && TIER_RANK[curr.tier] > TIER_RANK[baseline.tier])
    out.push({ level: "green", kind: "tier-up", text: `Safety upgraded ${baseline.tier} → ${curr.tier}` });
  return out;
}

// Price-move alert for /alert thresholds — fires when price moves ±pct since the
// previous check (cooldown keeps a fast mover from pinging every minute).
export function priceMoveAlert(prev, curr, pct) {
  if (!prev || !(prev.priceUsd > 0) || curr.priceUsd == null) return null;
  const ch = (curr.priceUsd / prev.priceUsd - 1) * 100;
  if (Math.abs(ch) >= pct) return { level: ch > 0 ? "green" : "red", kind: "price-move", text: `Price ${ch > 0 ? "+" : ""}${Math.round(ch)}% (±${pct}% alert)` };
  return null;
}

// A hedged, structure-based read on the RISK OF ENTERING NOW — never a price
// prediction or a buy signal. Rewards clean safety, stable/growing liquidity &
// holders, organic volume, locked LP, smart money; penalizes draining liquidity,
// fleeing holders, danger flags, and buying into a vertical pump (the top).
export function entryRead(curr, baseline) {
  const reasons = [];
  let score = 0;
  if (curr.tier === "clean") { score += 2; reasons.push("✅ safety looks clean"); }
  else if (curr.tier === "high-risk") { score -= 3; reasons.push("🚩 high-risk safety"); }
  else reasons.push("⚠️ mixed safety");

  if (baseline && baseline.liqQuote > 0 && curr.liqQuote != null) {
    const ch = (curr.liqQuote / baseline.liqQuote - 1) * 100;
    if (ch <= -15) { score -= 2; reasons.push("📉 liquidity draining"); }
    else if (ch >= -2) { score += 1; reasons.push("💧 liquidity stable/growing"); }
  }
  if (baseline && baseline.holders > 0 && curr.holders != null) {
    const ch = (curr.holders / baseline.holders - 1) * 100;
    if (ch <= -10) { score -= 1; reasons.push("👥 holders leaving"); }
    else if (ch >= 2) { score += 1; reasons.push("👥 holders growing"); }
  }
  if (baseline && baseline.volume24h > 0 && curr.volume24h != null && curr.volume24h < baseline.volume24h * 0.5) {
    score -= 1; reasons.push("🔇 volume fading");
  }
  if (curr.priceChange24h != null && curr.priceChange24h >= 100) { score -= 1; reasons.push("🔺 already pumping hard — high 'buying the top' risk"); }
  if (curr.lpLockedPct != null && curr.lpLockedPct >= 90) { score += 1; reasons.push("🔒 liquidity locked/burned"); }
  if ((curr.smartMoneyHolders ?? 0) > 0) { score += 1; reasons.push("🧠 tracked smart money holding"); }

  const rating = score >= 3 ? "constructive" : score <= -1 ? "poor" : "mixed";
  return { rating, score, reasons };
}

const RATING_EMOJI = { constructive: "🟢", mixed: "🟡", poor: "🔴" };
const NFA = "⚠️ <b>NFA.</b> This is a risk/structure read, not a price prediction or a buy signal. Tokens can go to zero. DYOR.";

export function formatEntry(snap, read) {
  return [
    `${RATING_EMOJI[read.rating]} <b>${esc(snap.symbol ? "$" + snap.symbol : short(snap.token))}</b> — entry read: <b>${read.rating}</b>`,
    ...read.reasons.map(r => "• " + r),
    NFA,
  ].join("\n");
}

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = m => m ? m.slice(0, 4) + "…" + m.slice(-4) : "token";

export function formatAlert(snap, alerts) {
  const sym = esc(snap.symbol ? "$" + snap.symbol : short(snap.token));
  const emoji = { clean: "✅", caution: "⚠️", "high-risk": "🚩" }[snap.tier] || "";
  const hasRed = alerts.some(a => a.level === "red");
  const allGreen = alerts.every(a => a.level === "green");
  const head = hasRed ? `🚨 <b>${sym}</b> ${emoji}` : allGreen ? `📈 <b>${sym}</b> — setup improving ${emoji}` : `👀 <b>${sym}</b> ${emoji}`;
  const body = alerts.map(a => `• ${esc(a.text)}`);
  const foot = `<a href="https://solscan.io/token/${snap.token}">Solscan</a> · safety ${snap.safety}/100`;
  const lines = [head, ...body, foot];
  if (allGreen) lines.push("⚠️ NFA — not a buy signal.");
  return lines.join("\n");
}

// Render the top-holder breakdown + deployer note for /scan. `deployer` is
// optional; if the creator is among the top holders we warn about their bag.
export function formatHolders(topHolders, deployer) {
  const lines = [];
  if (topHolders && topHolders.length) {
    const parts = topHolders.map(h => `${h.pct}%`);
    lines.push("👥 Top holders: " + parts.join(" · "));
  }
  if (deployer && deployer.creator) {
    const held = (topHolders || []).find(h => h.owner === deployer.creator);
    const bag = held ? ` — still holds ${held.pct}% ⚠️` : "";
    lines.push(`🛠️ Deployer: <a href="https://solscan.io/account/${deployer.creator}">${short(deployer.creator)}</a>${bag}${deployer.approx ? " (approx)" : ""}`);
  }
  return lines.join("\n");
}

/* ================= top-holder average entry price =================
   "What did the top holders actually pay?" — if they're sitting on 10x, you're
   exit liquidity; if they bought near spot, they're aligned with you.

   Method: take the top N holders by balance, pull each wallet's swap history,
   and reconstruct an average-cost basis for THIS mint (buys add tokens+cost,
   sells reduce both proportionally). Honest limits, surfaced in the output:
     • holders who received tokens by transfer/airdrop have NO on-chain buy —
       we count them separately, and a high count is itself an insider signal
     • buys older than the fetched history window can't be priced
     • pool/burn/CEX owners are excluded from "holders"
   Cost: one Helius call per holder, so this is ON-DEMAND only, never in a loop.
*/

// Pure: a wallet's average USD cost basis for one mint (average-cost method).
export function avgEntryForMint(trades, mint) {
  let tokens = 0, cost = 0, buys = 0;
  for (const t of [...(trades || [])].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!t || t.mint !== mint) continue;
    if (t.side === "buy") {
      tokens += Number(t.tokenAmount) || 0;
      cost += Number(t.quoteUsd) || 0;
      buys++;
    } else if (t.side === "sell" && tokens > 0) {
      const sold = Math.min(Number(t.tokenAmount) || 0, tokens);
      cost -= (cost / tokens) * sold; // average-cost reduction
      tokens -= sold;
    }
  }
  if (!buys || tokens <= 0 || cost <= 0) return null;
  return { avgPrice: cost / tokens, tokens, costUsd: cost, buys };
}

// Pure: roll per-holder entries into the numbers that drive a decision.
// rows = [{ owner, share, entry|null }] where share = fraction of the top-N bag.
export function summarizeEntries(rows, currentPrice) {
  const priced = (rows || []).filter(r => r.entry && r.entry.avgPrice > 0);
  const unpriced = (rows || []).length - priced.length;
  if (!priced.length) return { priced: 0, unpriced, avgEntry: null, multiple: null, inProfit: 0, weighted: null };
  // Weight by tokens still held: a whale's entry matters more than a small bag's.
  const totalTokens = priced.reduce((s, r) => s + r.entry.tokens, 0);
  const weighted = totalTokens > 0
    ? priced.reduce((s, r) => s + r.entry.avgPrice * (r.entry.tokens / totalTokens), 0)
    : null;
  const avgEntry = priced.reduce((s, r) => s + r.entry.avgPrice, 0) / priced.length;
  const inProfit = currentPrice > 0 ? priced.filter(r => currentPrice > r.entry.avgPrice).length : 0;
  const multiple = currentPrice > 0 && weighted > 0 ? currentPrice / weighted : null;
  return { priced: priced.length, unpriced, avgEntry, weighted, multiple, inProfit };
}

const price = n => {
  if (n == null) return "—";
  if (n >= 1) return "$" + n.toFixed(4);
  if (n >= 0.0001) return "$" + n.toFixed(6);
  return "$" + n.toExponential(2);
};

// A one/two-line version for /scan, where the full block would bury the verdict.
export function formatEntriesCompact(topN, sum, currentPrice) {
  if (!sum || (!sum.priced && !sum.unpriced)) return "";
  if (!sum.priced) return `💰 Top ${topN} entries: none priceable — ${sum.unpriced} holder(s) have <b>no on-chain buy</b> (airdropped/transferred) ⚠️`;
  const bits = [`avg ${price(sum.weighted)}`];
  if (sum.multiple != null) {
    const m = sum.multiple;
    const tag = m >= 5 ? "🚨 deep in profit" : m >= 2 ? "⚠️ up meaningfully" : m >= 0.95 ? "🟢 near your entry" : "🔻 underwater";
    bits.push(`${m >= 1 ? m.toFixed(1) + "× up" : (1 / m).toFixed(1) + "× down"} · ${tag}`);
  }
  let line = `💰 Top ${topN} entries: ${bits.join(" · ")}`;
  if (sum.unpriced) line += `\n   ⚠️ ${sum.unpriced} holder(s) with no on-chain buy (airdropped/insider?)`;
  return line;
}

export function formatEntries(mint, symbol, topN, rows, sum, currentPrice) {
  const lines = [`💰 <b>Top ${topN} holder entries</b> — ${esc(symbol ? "$" + symbol : short(mint))}`];
  if (!sum.priced) {
    lines.push(`Couldn't price any of the top ${topN} holders' entries.`);
    lines.push(`• ${sum.unpriced} holder(s) have <b>no on-chain buy</b> in visible history — airdropped/transferred, or bought earlier than we can see.`);
    lines.push("⚠️ NFA.");
    return lines.join("\n");
  }
  lines.push(`• Current price: <b>${price(currentPrice)}</b>`);
  lines.push(`• Avg entry (size-weighted): <b>${price(sum.weighted)}</b>`);
  lines.push(`• Avg entry (per wallet): ${price(sum.avgEntry)}`);
  if (sum.multiple != null) {
    const m = sum.multiple;
    const verdict = m >= 5 ? "🚨 they're deep in profit — high dump risk"
      : m >= 2 ? "⚠️ they're up meaningfully"
      : m >= 0.95 ? "🟢 roughly aligned with your entry"
      : "🔻 they're underwater";
    lines.push(`• Top holders are <b>${m >= 1 ? m.toFixed(1) + "× up" : (1 / m).toFixed(1) + "× down"}</b> — ${verdict}`);
  }
  lines.push(`• ${sum.inProfit}/${sum.priced} priced holders in profit`);
  if (sum.unpriced) lines.push(`• ⚠️ ${sum.unpriced} holder(s) have <b>no on-chain buy</b> (airdropped/transferred, or older than visible history) — common with insider allocations`);
  lines.push("⚠️ NFA — cost basis is reconstructed from visible swap history and may be incomplete.");
  return lines.join("\n");
}

/* ================= follow: every-trade alerts for specific wallets =========
   /follow <wallet> — ping on EVERY trade (buy AND sell) that wallet makes, not
   just first-time buys. Dedup is per transaction signature, baselined from the
   wallet's recent history on first sight so old trades never fire.
   Latency honesty: this polls every WALLET_POLL_SECONDS (default 45s), so
   "immediately" means within ~a minute, not the same block.
*/

// Pure: which trades are new (unseen signature), fresh, and big enough?
export function detectNewTrades(trades, seenSigs, { sinceTs = 0, minUsd = 0 } = {}) {
  const out = [];
  for (const t of [...(trades || [])].sort((a, b) => b.timestamp - a.timestamp)) {
    if (!t || !t.mint || !t.signature) continue;
    if (t.timestamp < sinceTs) continue;
    if ((t.quoteUsd || 0) < minUsd) continue;
    if (seenSigs?.has(t.signature)) continue;
    out.push(t);
  }
  return out;
}

export function formatTrade(who, t) {
  const side = t.side === "buy" ? "🟢 <b>BUY</b>" : "🔴 <b>SELL</b>";
  const usdAmt = t.quoteUsd >= 1000 ? `$${(t.quoteUsd / 1000).toFixed(1)}K` : `$${Math.round(t.quoteUsd)}`;
  return [
    `${side} — ${esc(who)}`,
    `• ${short(t.mint)} · ${usdAmt}`,
    `<a href="https://solscan.io/token/${t.mint}">token</a>${t.signature ? ` · <a href="https://solscan.io/tx/${t.signature}">tx</a>` : ""} · <code>${t.mint}</code>`,
    `↳ /scan ${t.mint} for the rug check`,
  ].join("\n");
}

/* ================= signals: first-time-buy copy-trade alerts =================
   Watch tracked wallets and fire the moment one opens a NEW position — a token
   it has never bought before (within our visible history). That's the alpha
   signal; we pair it with an instant safety scan so you see the rug check in the
   same message.

   "First time" is judged against the mints already seen in that wallet's swap
   history, which we baseline on the first poll. Honest limit: history is a
   couple of pages deep, so it means "first buy we can see" — a position opened
   long ago and re-bought could read as new. We say so in the message.
*/

// Every mint that appears anywhere in a wallet's trade history (buys or sells) —
// the baseline of "already known positions", so we never alert on an old bag.
export function seedSeenMints(trades) {
  const s = new Set();
  for (const t of trades || []) if (t?.mint) s.add(t.mint);
  return s;
}

// Pure: which trades are fresh, big-enough, FIRST-TIME buys? Does not mutate.
export function detectFirstBuys(trades, seen, { sinceTs = 0, minUsd = 0 } = {}) {
  const out = [];
  const byMint = new Set();
  for (const t of [...(trades || [])].sort((a, b) => b.timestamp - a.timestamp)) {
    if (!t || t.side !== "buy" || !t.mint) continue;
    if (t.timestamp < sinceTs) continue;
    if ((t.quoteUsd || 0) < minUsd) continue;
    if (seen?.has(t.mint) || byMint.has(t.mint)) continue; // already held, or dupe in this batch
    byMint.add(t.mint);
    out.push(t);
  }
  return out;
}

// The signal message: who bought what, how much — plus our safety read, which is
// the whole point of pairing copy-trade alpha with the scanner.
export function formatFirstBuy(who, buy, scan) {
  const usdAmt = buy.quoteUsd >= 1000 ? `$${(buy.quoteUsd / 1000).toFixed(1)}K` : `$${Math.round(buy.quoteUsd)}`;
  const sym = scan?.market?.symbol ? "$" + scan.market.symbol : short(buy.mint);
  const lines = [`🎯 <b>FIRST BUY</b> — ${esc(who)} just opened a new position`, `• ${esc(sym)} · ${usdAmt}`];
  if (scan && !scan.error) {
    const v = { clean: "✅ looks clean", caution: "⚠️ caution", "high-risk": "🚩 HIGH RISK" }[scan.tier] || scan.tier;
    lines.push(`• Safety: <b>${scan.safety}/100</b> · ${v}`);
    const worst = (scan.flags || []).find(f => f.level === "red");
    if (worst) lines.push(`• ${esc(worst.text)}`);
    if ((scan.smartMoneyHolders ?? 0) > 1) lines.push(`• 🧠 ${scan.smartMoneyHolders} tracked wallets hold this`);
  }
  lines.push(`<a href="https://solscan.io/token/${buy.mint}">token</a>${buy.signature ? ` · <a href="https://solscan.io/tx/${buy.signature}">tx</a>` : ""} · <code>${buy.mint}</code>`);
  lines.push("⚠️ NFA — first buy we can see in this wallet's history.");
  return lines.join("\n");
}

// Discovery config for the bot — deliberately LIGHTER than the CLI defaults,
// because this fans out to a lot of RPC calls and we're on a free Helius tier.
// (CLI: 10 trending × 20 holders × 2 swap pages; here: 5 × 10, 1 page.)
export function discoveryCfg(over = {}) {
  return {
    trending: 5, holderPages: 1, perToken: 10, maxCandidates: 25, swapPages: 1,
    minPnlUsd: 5000, minWinRatePct: 50, minTrades: 5, limit: 8, solPriceUsd: 0,
    ...over,
  };
}

// Which discovered wallets are new to our list, and a Telegram summary.
export function pickNewWhales(smart, existing) {
  const have = new Set((existing || []).map(w => w.wallet));
  return (smart || []).filter(s => s.wallet && !have.has(s.wallet));
}

export function formatDiscovery(smart, added, scanned) {
  if (!smart || !smart.length) return `🔍 Scanned ${scanned ?? 0} trending tokens — no wallets cleared the smart-money bar this time. Try again later.`;
  const lines = [`🧠 <b>Discovered ${smart.length} smart-money wallet(s)</b>`];
  for (const s of smart) {
    const pnl = typeof s.realizedUsd === "number" ? ` · ${s.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(Math.round(s.realizedUsd)).toLocaleString("en-US")}` : "";
    const wr = typeof s.winRatePct === "number" ? ` · ${Math.round(s.winRatePct)}% win` : "";
    lines.push(`• <a href="https://solscan.io/account/${s.wallet}">${short(s.wallet)}</a>${pnl}${wr}`);
  }
  lines.push(added > 0 ? `\n✅ Added ${added} new wallet(s) to tracking. /whales to review · /delwhale to remove.` : `\nAll already tracked.`);
  lines.push("⚠️ NFA — past PnL is not a guarantee of future performance.");
  return lines.join("\n");
}

// The daily digest — a portfolio snapshot of every watched token.
export function buildDigest(entries) {
  if (!entries || !entries.length) return null;
  const lines = ["📊 <b>Daily watchlist digest</b>"];
  for (const { snap, base } of entries) {
    const emoji = { clean: "✅", caution: "⚠️", "high-risk": "🚩" }[snap.tier] || "";
    let trend = "";
    if (base && base.liqQuote > 0 && snap.liqQuote != null) {
      const ch = Math.round((snap.liqQuote / base.liqQuote - 1) * 100);
      trend = ` · liq ${ch >= 0 ? "+" : ""}${ch}%`;
    }
    lines.push(`${emoji} <b>${esc(snap.symbol ? "$" + snap.symbol : short(snap.token))}</b> ${snap.safety}/100${trend}${snap.holders != null ? ` · ${snap.holders} holders` : ""}`);
  }
  lines.push("⚠️ NFA.");
  return lines.join("\n");
}

// New UTC day AND at/after the digest hour → time to send today's digest.
export function shouldDigest(lastDayKey, now, hourUTC) {
  const d = new Date(now);
  const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  if (dayKey === lastDayKey) return false;
  return d.getUTCHours() >= hourUTC;
}
export function dayKeyOf(now) { const d = new Date(now); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; }

export function parseCommand(text) {
  const t = (text || "").trim();
  const [cmd, ...rest] = t.split(/\s+/);
  const arg = rest.join(" ").trim();
  const c = (cmd || "").toLowerCase().replace(/@.*$/, ""); // strip @botname
  if (c === "/watch") return { cmd: "watch", arg };
  if (c === "/unwatch") return { cmd: "unwatch", arg };
  if (c === "/list") return { cmd: "list" };
  if (c === "/scan") return { cmd: "scan", arg };
  if (c === "/entry") return { cmd: "entry", arg };
  if (c === "/trending") return { cmd: "trending" };
  if (c === "/alert") { const [mint, pct] = rest; return { cmd: "alert", mint, pct }; }
  if (c === "/whales") return { cmd: "whales" };
  if (c === "/addwhale") return { cmd: "addwhale", wallet: rest[0], label: rest.slice(1).join(" ") };
  if (c === "/delwhale") return { cmd: "delwhale", wallet: rest[0] };
  if (c === "/discoverwhales" || c === "/discover") return { cmd: "discoverwhales" };
  if (c === "/flagwallet") return { cmd: "flagwallet", wallet: rest[0], label: rest.slice(1).join(" ") };
  if (c === "/flagged") return { cmd: "flagged" };
  if (c === "/unflagwallet") return { cmd: "unflagwallet", wallet: rest[0] };
  if (c === "/entries") { const [mint, n] = rest; return { cmd: "entries", mint, topN: n }; }
  if (c === "/signals") return { cmd: "signals", arg };
  if (c === "/follow") return { cmd: "follow", wallet: rest[0], label: rest.slice(1).join(" ") };
  if (c === "/following") return { cmd: "following" };
  if (c === "/unfollow") return { cmd: "unfollow", wallet: rest[0] };
  if (c === "/save") return { cmd: "save" };
  if (c === "/mute") return { cmd: "mute" };
  if (c === "/unmute") return { cmd: "unmute" };
  if (c === "/help" || c === "/start") return { cmd: "help" };
  return { cmd: "unknown", raw: t };
}

/* ================= Telegram-native persistence =================
   Railway wipes the container disk on every redeploy, so a file alone is not
   permanent. Instead the bot stores its state in a PINNED MESSAGE in your chat:
   Telegram keeps it forever, it costs nothing, and it needs no dashboard setup —
   everything you do from Telegram survives restarts, redeploys, and host moves.
   The local file stays as a fast cache; env vars still work as a seed.
   Limit: a Telegram message is 4096 chars (~80+ addresses), and we warn near it.
*/

export const STATE_MARKER = "🗄️ Rug or Moon saved state — do not unpin";
const STATE_LIMIT = 3500;

// Pure: state → the text of the pinned message.
export function serializeState(state) {
  const payload = {
    v: 1,
    watch: [...(state.watch || [])],
    whales: (state.whales || []).map(w => (w.label ? { wallet: w.wallet, label: w.label } : w.wallet)),
    flagged: (state.flagged || []).map(w => (w.label ? { wallet: w.wallet, label: w.label } : w.wallet)),
    followed: (state.followed || []).map(w => (w.label ? { wallet: w.wallet, label: w.label } : w.wallet)),
    alerts: [...(state.priceAlerts || new Map())].map(([m, p]) => [m, p]),
  };
  return `${STATE_MARKER}\n${JSON.stringify(payload)}`;
}

// Pure: the pinned message text → state, or null if it isn't ours / is corrupt.
export function parseStateMessage(text) {
  if (!text || !text.includes(STATE_MARKER)) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const o = JSON.parse(text.slice(start));
    const norm = arr => (Array.isArray(arr) ? arr : []).map(w => (typeof w === "string" ? { wallet: w, label: "" } : w))
      .filter(w => w && BASE58.test(w.wallet || ""));
    return {
      watch: (Array.isArray(o.watch) ? o.watch : []).filter(m => BASE58.test(m)),
      whales: norm(o.whales),
      flagged: norm(o.flagged),
      followed: norm(o.followed),
      alerts: (Array.isArray(o.alerts) ? o.alerts : []).filter(a => Array.isArray(a) && BASE58.test(a[0]) && Number(a[1]) > 0),
    };
  } catch { return null; }
}

// Merge restored state into the live state (union with whatever env/file seeded).
export function applyState(state, loaded) {
  if (!loaded) return state;
  for (const m of loaded.watch) state.watch.add(m);
  const mergeList = (cur, add) => {
    const by = new Map(cur.map(w => [w.wallet, w]));
    for (const w of add) if (!by.has(w.wallet)) by.set(w.wallet, w);
    return [...by.values()];
  };
  state.whales = mergeList(state.whales || [], loaded.whales);
  state.flagged = mergeList(state.flagged || [], loaded.flagged);
  state.followed = mergeList(state.followed || [], loaded.followed || []);
  for (const [m, p] of loaded.alerts) state.priceAlerts.set(m, Number(p));
  return state;
}

/* ================= watchlist persistence ================= */

function loadWatchlist(file, seed) {
  const set = new Set();
  if (existsSync(file)) {
    try { for (const m of JSON.parse(readFileSync(file, "utf8"))) if (BASE58.test(m)) set.add(m); } catch { /* ignore */ }
  }
  for (const m of (seed || "").split(",").map(s => s.trim()).filter(Boolean)) if (BASE58.test(m)) set.add(m);
  return set;
}
function saveWatchlist(file, set) {
  try { writeFileSync(file, JSON.stringify([...set], null, 2)); } catch (e) { console.error("watchlist save failed:", e.message); }
}

// Smart-money (whale) wallet list — [{wallet,label}]. Seeded from a file and/or
// the SMART_MONEY_JSON env (inline JSON, survives redeploys), merged + deduped.
export function loadWhales(file, seedJson) {
  const byWallet = new Map();
  const add = arr => { for (const w of (Array.isArray(arr) ? arr : [])) { const e = typeof w === "string" ? { wallet: w, label: "" } : w; if (e && BASE58.test(e.wallet || "")) byWallet.set(e.wallet, { wallet: e.wallet, label: e.label || "" }); } };
  if (file && existsSync(file)) { try { add(JSON.parse(readFileSync(file, "utf8"))); } catch { /* ignore */ } }
  if (seedJson) { try { add(JSON.parse(seedJson)); } catch { /* ignore */ } }
  return [...byWallet.values()];
}
function saveWhales(file, list) {
  try { writeFileSync(file, JSON.stringify(list, null, 2)); } catch (e) { console.error("whale save failed:", e.message); }
}

// Flagged wallets — the inverse list: warn me if one of these holds a token I
// scan. Same storage shape as whales (file + inline-JSON env that survives
// redeploys), so loadWhales/saveWhales are reused.
const saveFlagged = saveWhales;

/* ================= runtime (needs network + a real bot token) ================= */

const HELP = [
  "🧅 <b>Rug or Moon — liquidity watcher</b>",
  "I watch your tokens and ping you when liquidity drains, volume fades, holders leave, safety drops, or smart money exits.",
  "",
  "<b>/watch</b> &lt;mint&gt; — start watching a token",
  "<b>/unwatch</b> &lt;mint&gt; — stop watching",
  "<b>/list</b> — show watched tokens",
  "<b>/scan</b> &lt;mint&gt; — full scan: safety, top holders, deployer, entry read",
  "<b>/entry</b> &lt;mint&gt; — entry read only (NFA)",
  "<b>/trending</b> — today's trending tokens, auto-scanned (gems up top)",
  "<b>/alert</b> &lt;mint&gt; &lt;pct&gt; — ping on a ±% price move (e.g. /alert &lt;mint&gt; 20). off to clear",
  "<b>/addwhale</b> &lt;wallet&gt; [label] — track a smart-money wallet",
  "<b>/discoverwhales</b> — auto-find profitable wallets and track them",
  "<b>/whales</b> · <b>/delwhale</b> &lt;wallet&gt; — list / remove tracked wallets",
  "<b>/flagwallet</b> &lt;wallet&gt; [label] — warn me if this wallet holds a token I scan",
  "<b>/flagged</b> · <b>/unflagwallet</b> &lt;wallet&gt; — list / remove flagged wallets",
  "<b>/entries</b> &lt;mint&gt; [10|20|50] — what the top holders actually paid (avg entry vs now)",
  "<b>/signals</b> [on|off] — ping me when a tracked wallet makes a FIRST buy of a new token",
  "<b>/follow</b> &lt;wallet&gt; [label] — ping me on EVERY trade (buy AND sell) this wallet makes",
  "<b>/following</b> · <b>/unfollow</b> &lt;wallet&gt; — list / remove followed wallets",
  "<b>/save</b> — force-save your setup (it auto-saves on every change)",
  "<b>/mute</b> · <b>/unmute</b> — pause/resume alerts",
  "<b>/help</b> — this message",
  "",
  "💾 Everything you add is saved in a pinned message in this chat, so it survives restarts and redeploys. Don't unpin it.",
].join("\n");

async function tgReply(env, text) { return sendTelegram(env, text, fetch, env.TELEGRAM_CHAT_ID); }

const tgApi = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(r => r.json());

// Read the pinned message and restore state from it (permanent across redeploys).
async function restoreState(env, state) {
  try {
    const chat = await tgApi(env, "getChat", { chat_id: env.TELEGRAM_CHAT_ID });
    const pinned = chat?.result?.pinned_message;
    const loaded = parseStateMessage(pinned?.text || "");
    if (loaded) {
      applyState(state, loaded);
      state.stateMsgId = pinned.message_id;
      return loaded;
    }
  } catch (e) { console.error("restoreState failed:", e.message); }
  return null;
}

// Write state into the pinned message (edit in place if we already have one).
// Called after every mutation, so "saved" always means "survives a redeploy".
async function persistState(env, state) {
  const text = serializeState(state);
  if (text.length > STATE_LIMIT) {
    await tgReply(env, "⚠️ Saved state is getting close to Telegram's message limit — consider removing some watched tokens or wallets.").catch(() => {});
  }
  try {
    if (state.stateMsgId) {
      const r = await tgApi(env, "editMessageText", { chat_id: env.TELEGRAM_CHAT_ID, message_id: state.stateMsgId, text, disable_web_page_preview: true });
      if (r?.ok || /message is not modified/i.test(r?.description || "")) return true;
      state.stateMsgId = null; // stale id (message deleted) → fall through and re-create
    }
    const sent = await tgApi(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, disable_notification: true });
    if (!sent?.ok) return false;
    state.stateMsgId = sent.result.message_id;
    await tgApi(env, "pinChatMessage", { chat_id: env.TELEGRAM_CHAT_ID, message_id: state.stateMsgId, disable_notification: true });
    return true;
  } catch (e) { console.error("persistState failed:", e.message); return false; }
}

// Top-holder entry prices for /scan. Deliberately shallow (SCAN_ENTRIES_TOP,
// default 10) because it costs one RPC call per holder — /entries goes deeper.
// Any failure returns "" so the scan itself is never broken by this extra.
async function entriesLineFor(env, cfg, state, mint, scan) {
  const topN = cfg.scanEntriesTop;
  if (!topN || !env.HELIUS_API_KEY) return "";
  try {
    const helius = env.HELIUS_API_KEY;
    const client = makeClient(env, fetch);
    const rep = await holderEntryReport(mint, {
      getTokenAccounts: m => fetch("https://mainnet.helius-rpc.com/?api-key=" + helius, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccounts", params: { mint: m, limit: 1000, page: 1 } }),
      }).then(r => r.json()),
      getWalletSwaps: (w, p) => client.walletSwaps(w, p),
      topN, pages: cfg.entriesSwapPages,
      solPriceUsd: state.solPriceUsd || 150,
      excluded: new Set(scan?.excludedOwners || []),
    });
    return formatEntriesCompact(rep.ranked || topN, summarizeEntries(rep.rows, scan?.market?.priceUsd || 0), scan?.market?.priceUsd || 0);
  } catch { return ""; }
}

async function scanMessage(env, cfg, state, mint, withEntry) {
  // Deployer lookup runs in parallel with the scan (it's a couple of extra RPC
  // calls, so on-demand only — never in the fast monitor loop).
  const [d, deployer] = await Promise.all([
    scanToken(mint, { heliusKey: env.HELIUS_API_KEY, smartMoney: state.smartMoney, flagged: state.flaggedSet }),
    findDeployer(mint, { heliusKey: env.HELIUS_API_KEY }).catch(() => null),
  ]);
  if (d.error) return `⚠️ ${esc(d.error)}`;
  const entriesLine = await entriesLineFor(env, cfg, state, mint, d); // "" if disabled/failed
  const snap = buildSnapshot(d, mint);
  const v = { clean: "✅ Looks clean", caution: "⚠️ Caution", "high-risk": "🚩 High risk" }[d.tier] || d.tier;
  const top = (d.flags || []).filter(f => f.level !== "green").slice(0, 4).map(f => `• ${esc(f.text)}`).join("\n");
  const holders = formatHolders(d.topHolders, deployer);
  let msg = `<b>${esc(d.market?.symbol ? "$" + d.market.symbol : short(mint))}</b> — ${d.safety}/100 · ${v}\n${top || "No red/yellow flags."}`;
  if (holders) msg += "\n" + holders;
  if (entriesLine) msg += "\n" + entriesLine;
  msg += `\n<a href="https://solscan.io/token/${mint}">Solscan</a>`;
  if (withEntry) msg += "\n\n" + formatEntry(snap, entryRead(snap, state.baseline.get(mint)?.snap));
  return msg;
}

async function handleCommand(env, cfg, state, text) {
  const { cmd, arg } = parseCommand(text);
  if (cmd === "help") return tgReply(env, HELP);
  if (cmd === "list") {
    const list = [...state.watch];
    return tgReply(env, list.length ? "👀 Watching:\n" + list.map(m => `• <a href="https://solscan.io/token/${m}">${short(m)}</a>`).join("\n") : "Not watching anything yet. /watch &lt;mint&gt;");
  }
  if (cmd === "watch") {
    if (!BASE58.test(arg)) return tgReply(env, "That doesn't look like a valid mint address.");
    state.watch.add(arg); saveWatchlist(cfg.file, state.watch);
    return tgReply(env, `✅ Now watching <a href="https://solscan.io/token/${arg}">${short(arg)}</a>. I'll baseline it on the next check.`);
  }
  if (cmd === "unwatch") {
    state.watch.delete(arg); state.last.delete(arg); saveWatchlist(cfg.file, state.watch);
    return tgReply(env, `Removed ${short(arg)}.`);
  }
  if (cmd === "scan") {
    if (!BASE58.test(arg)) return tgReply(env, "Give me a valid mint: /scan &lt;mint&gt;");
    return tgReply(env, await scanMessage(env, cfg, state, arg, true));
  }
  if (cmd === "entry") {
    if (!BASE58.test(arg)) return tgReply(env, "Give me a valid mint: /entry &lt;mint&gt;");
    const d = await scanToken(arg, { heliusKey: env.HELIUS_API_KEY, smartMoney: state.smartMoney, flagged: state.flaggedSet });
    if (d.error) return tgReply(env, `⚠️ ${esc(d.error)}`);
    const snap = buildSnapshot(d, arg);
    return tgReply(env, formatEntry(snap, entryRead(snap, state.baseline.get(arg)?.snap)));
  }
  if (cmd === "trending") {
    const res = await scanTrending({ limit: 8, heliusKey: env.HELIUS_API_KEY, birdeyeKey: env.BIRDEYE_API_KEY, smartMoney: state.smartMoney }).catch(() => null);
    if (!res || !res.tokens?.length) return tgReply(env, "Couldn't load trending right now — try again shortly.");
    const rows = res.tokens.map(t => {
      const e = { clean: "✅", caution: "⚠️", "high-risk": "🚩" }[t.tier] || "";
      return `${e} <b>${esc(t.market?.symbol ? "$" + t.market.symbol : short(t.token))}</b> ${t.safety}/100 · <a href="https://solscan.io/token/${t.token}">scan</a>`;
    });
    return tgReply(env, `🔥 <b>Trending</b> (${res.source}) — safest first\n${rows.join("\n")}\n⚠️ NFA.`);
  }
  if (cmd === "alert") {
    const { mint, pct } = parseCommand(text);
    if (!BASE58.test(mint || "")) return tgReply(env, "Usage: /alert &lt;mint&gt; &lt;pct&gt;  (e.g. /alert &lt;mint&gt; 20, or /alert &lt;mint&gt; off)");
    if ((pct || "").toLowerCase() === "off") { state.priceAlerts.delete(mint); return tgReply(env, `Price alert cleared for ${short(mint)}.`); }
    const n = Number(pct);
    if (!(n > 0)) return tgReply(env, "Give a positive %: /alert &lt;mint&gt; 20");
    state.priceAlerts.set(mint, n);
    if (!state.watch.has(mint)) { state.watch.add(mint); saveWatchlist(cfg.file, state.watch); }
    return tgReply(env, `🔔 Will ping on a ±${n}% move for ${short(mint)}. (Now watched too.)`);
  }
  if (cmd === "whales") {
    return tgReply(env, state.whales.length
      ? "🧠 Tracked smart-money wallets:\n" + state.whales.map(w => `• <a href="https://solscan.io/account/${w.wallet}">${esc(w.label || short(w.wallet))}</a>`).join("\n")
      : "No smart-money wallets yet. Add one: /addwhale &lt;wallet&gt; [label]");
  }
  if (cmd === "addwhale") {
    const { wallet, label } = parseCommand(text);
    if (!BASE58.test(wallet || "")) return tgReply(env, "Usage: /addwhale &lt;wallet&gt; [label]");
    if (state.whales.some(w => w.wallet === wallet)) return tgReply(env, "Already tracking that wallet.");
    state.whales.push({ wallet, label: label || "" });
    saveWhales(cfg.whaleFile, state.whales);
    state.smartMoney = parseSmartMoney(state.whales);
    return tgReply(env, `🧠 Added smart-money wallet ${label ? esc(label) + " " : ""}${short(wallet)}. Scans now flag tokens it holds.`);
  }
  if (cmd === "delwhale") {
    const { wallet } = parseCommand(text);
    state.whales = state.whales.filter(w => w.wallet !== wallet);
    saveWhales(cfg.whaleFile, state.whales);
    state.smartMoney = parseSmartMoney(state.whales);
    return tgReply(env, `Removed ${short(wallet || "")}.`);
  }
  if (cmd === "flagged") {
    return tgReply(env, state.flagged.length
      ? "🚩 Flagged wallets (I'll warn you if these hold a token you scan):\n" + state.flagged.map(w => `• <a href="https://solscan.io/account/${w.wallet}">${esc(w.label || short(w.wallet))}</a>`).join("\n")
      : "No flagged wallets. Add one: /flagwallet &lt;wallet&gt; [label]");
  }
  if (cmd === "flagwallet") {
    const { wallet, label } = parseCommand(text);
    if (!BASE58.test(wallet || "")) return tgReply(env, "Usage: /flagwallet &lt;wallet&gt; [label]");
    if (state.flagged.some(w => w.wallet === wallet)) return tgReply(env, "Already flagged that wallet.");
    state.flagged.push({ wallet, label: label || "" });
    saveFlagged(cfg.flaggedFile, state.flagged);
    state.flaggedSet = parseSmartMoney(state.flagged);
    return tgReply(env, `🚩 Flagged ${label ? esc(label) + " " : ""}${short(wallet)}. Any token you scan that it holds will show a red warning — and I'll alert you if it buys into a token you're watching.`);
  }
  if (cmd === "unflagwallet") {
    const { wallet } = parseCommand(text);
    state.flagged = state.flagged.filter(w => w.wallet !== wallet);
    saveFlagged(cfg.flaggedFile, state.flagged);
    state.flaggedSet = parseSmartMoney(state.flagged);
    return tgReply(env, `Unflagged ${short(wallet || "")}.`);
  }
  if (cmd === "discoverwhales") {
    if (!env.HELIUS_API_KEY) return tgReply(env, "Discovery needs HELIUS_API_KEY set in the host's variables.");
    if (state.discovering) return tgReply(env, "Already running a discovery — hang on.");
    const now = Date.now();
    if (state.lastDiscover && now - state.lastDiscover < cfg.discoverCooldownMs) {
      const mins = Math.ceil((cfg.discoverCooldownMs - (now - state.lastDiscover)) / 60_000);
      return tgReply(env, `Discovery is rate-limited (it makes a lot of RPC calls) — try again in ~${mins} min.`);
    }
    state.discovering = true;
    await tgReply(env, "🔍 Scanning trending tokens → their top holders → scoring each wallet's PnL. This takes a minute…").catch(() => {});
    try {
      const client = makeClient(env, fetch);
      const res = await discoverSmartMoney(discoveryCfg(), client, m => console.log("[discover]", m));
      const fresh = pickNewWhales(res.smart, state.whales);
      for (const s of fresh) state.whales.push({ wallet: s.wallet, label: "" });
      if (fresh.length) { saveWhales(cfg.whaleFile, state.whales); state.smartMoney = parseSmartMoney(state.whales); }
      state.lastDiscover = Date.now();
      return tgReply(env, formatDiscovery(res.smart, fresh.length, res.scannedTokens));
    } catch (e) {
      return tgReply(env, `Discovery failed: ${esc(e.message || String(e))}`);
    } finally { state.discovering = false; }
  }
  if (cmd === "entries") {
    const { mint, topN } = parseCommand(text);
    if (!BASE58.test(mint || "")) return tgReply(env, "Usage: /entries &lt;mint&gt; [10|20|50] — what the top holders paid");
    if (!env.HELIUS_API_KEY) return tgReply(env, "This needs HELIUS_API_KEY set in the host's variables.");
    const n = Math.min(50, Math.max(5, Number(topN) || 20));
    const now = Date.now();
    if (state.lastEntries && now - state.lastEntries < cfg.entriesCooldownMs) {
      const mins = Math.ceil((cfg.entriesCooldownMs - (now - state.lastEntries)) / 60_000);
      return tgReply(env, `That's one RPC call per holder, so it's rate-limited — try again in ~${mins} min.`);
    }
    state.lastEntries = now;
    await tgReply(env, `💰 Pricing the top ${n} holders' entries — one lookup each, give me a moment…`).catch(() => {});
    try {
      const helius = env.HELIUS_API_KEY;
      const rpc = (method, params) => fetch("https://mainnet.helius-rpc.com/?api-key=" + helius, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then(r => r.json());
      const client = makeClient(env, fetch);
      const [scan, report] = await Promise.all([
        scanToken(mint, { heliusKey: helius, smartMoney: state.smartMoney, flagged: state.flaggedSet }),
        holderEntryReport(mint, {
          getTokenAccounts: m => rpc("getTokenAccounts", { mint: m, limit: 1000, page: 1 }),
          getWalletSwaps: (w, p) => client.walletSwaps(w, p),
          topN: n, pages: cfg.entriesSwapPages, solPriceUsd: state.solPriceUsd || 150,
        }),
      ]);
      const cur = scan?.market?.priceUsd || 0;
      const sum = summarizeEntries(report.rows, cur);
      return tgReply(env, formatEntries(mint, scan?.market?.symbol, report.ranked || n, report.rows, sum, cur));
    } catch (e) {
      return tgReply(env, `Couldn't build the entry report: ${esc(e.message || String(e))}`);
    }
  }
  if (cmd === "signals") {
    const a = (arg || "").toLowerCase();
    if (a === "on" || a === "off") {
      state.signalsOn = a === "on";
      if (state.signalsOn) state.walletSeen.clear(); // re-baseline so we don't fire on old bags
      return tgReply(env, state.signalsOn
        ? `🎯 First-buy signals ON — I'll ping you when any of your ${state.whales.length} tracked wallet(s) opens a NEW position (min $${cfg.signalMinUsd}). Baselining now, so alerts start from the next check.`
        : "First-buy signals OFF.");
    }
    return tgReply(env, `🎯 First-buy signals: <b>${state.signalsOn ? "ON" : "OFF"}</b> · ${state.whales.length} tracked wallet(s) · min $${cfg.signalMinUsd} · checked every ${cfg.walletPollSeconds}s.\nUse /signals on or /signals off.`);
  }
  if (cmd === "follow") {
    const { wallet, label } = parseCommand(text);
    if (!BASE58.test(wallet || "")) return tgReply(env, "Usage: /follow &lt;wallet&gt; [label] — ping me on EVERY trade this wallet makes");
    if (!env.HELIUS_API_KEY) return tgReply(env, "Following needs HELIUS_API_KEY set in the host's variables.");
    if (state.followed.some(w => w.wallet === wallet)) return tgReply(env, "Already following that wallet.");
    state.followed.push({ wallet, label: label || "" });
    state.followSeen.delete(wallet); // force a fresh baseline so we don't fire on its backlog
    return tgReply(env, `👁️ Following ${label ? esc(label) + " " : ""}${short(wallet)} — I'll ping you on every buy AND sell it makes (checked every ${cfg.walletPollSeconds}s). Baselining now, so alerts start from its next trade.`);
  }
  if (cmd === "following") {
    return tgReply(env, state.followed.length
      ? "👁️ Following (every trade):\n" + state.followed.map(w => `• <a href="https://solscan.io/account/${w.wallet}">${esc(w.label || short(w.wallet))}</a>`).join("\n")
      : "Not following any wallets. Add one: /follow &lt;wallet&gt; [label]");
  }
  if (cmd === "unfollow") {
    const { wallet } = parseCommand(text);
    state.followed = state.followed.filter(w => w.wallet !== wallet);
    state.followSeen.delete(wallet || "");
    return tgReply(env, `Unfollowed ${short(wallet || "")}.`);
  }
  if (cmd === "save") {
    const ok = await persistState(env, state);
    return tgReply(env, ok
      ? `💾 Saved — ${state.watch.size} token(s), ${state.whales.length} whale(s), ${state.flagged.length} flagged, ${state.followed.length} followed. This survives restarts and redeploys.`
      : "Couldn't save. Make sure I'm allowed to pin messages in this chat.");
  }
  if (cmd === "mute") { state.muted = true; return tgReply(env, "🔕 Alerts muted — /unmute to resume. (Commands still work.)"); }
  if (cmd === "unmute") { state.muted = false; return tgReply(env, "🔔 Alerts back on."); }
  return tgReply(env, "Unknown command. /help");
}

const onCooldown = (state, mint, kind, ms, now) => { const t = state.cooldown.get(`${mint}:${kind}`); return t != null && now - t < ms; };

// One monitoring pass: scan each watched token, diff FAST signals (liquidity /
// price / flags) vs the previous check and SLOW signals (volume / holders) vs a
// ~baselineMs-old snapshot, apply a per-alert-kind cooldown so a slow drain
// doesn't ping every minute, then send (unless muted).
export async function monitorOnce(env, cfg, state, scan = scanToken, now = Date.now()) {
  for (const mint of state.watch) {
    let d;
    try { d = await scan(mint, { heliusKey: env.HELIUS_API_KEY, smartMoney: state.smartMoney, flagged: state.flaggedSet }); } catch { continue; }
    if (!d || d.error) continue;
    const snap = buildSnapshot(d, mint);
    const prev = state.last.get(mint);
    const base = state.baseline.get(mint);
    if (prev) {
      const pm = state.priceAlerts.has(mint) ? priceMoveAlert(prev, snap, state.priceAlerts.get(mint)) : null;
      let alerts = [
        ...alertsFor(prev, snap, cfg.dropPct),
        ...trendAlerts(base?.snap, snap, cfg),
        ...improvementAlerts(base?.snap, snap, cfg),
        ...(pm ? [pm] : []),
      ].filter(a => !onCooldown(state, mint, a.kind, cfg.cooldownMs, now));
      if (alerts.length && !state.muted) {
        await tgReply(env, formatAlert(snap, alerts));
        for (const a of alerts) state.cooldown.set(`${mint}:${a.kind}`, now);
      }
    }
    state.last.set(mint, snap);
    if (!base || now - base.ts >= cfg.baselineMs) state.baseline.set(mint, { snap, ts: now });
  }
}

async function commandLoop(env, cfg, state) {
  let offset = 0;
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`);
      const j = await r.json();
      for (const u of (j.result || [])) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) continue; // only obey the owner
        // Persist whenever a command actually changed the saved state. Diffing the
        // serialized form covers every mutation (watch/whales/flagged/alerts/
        // discovery) without each handler having to remember to save.
        const before = serializeState(state);
        await handleCommand(env, cfg, state, msg.text || "").catch(e => console.error("cmd error:", e.message));
        if (serializeState(state) !== before) await persistState(env, state);
      }
    } catch (e) { console.error("getUpdates error:", e.message); await sleep(3000); }
  }
}

// Build the top-holder entry report. `client` supplies topHolders + walletSwaps;
// `excluded` is a set of owners to skip (pools/burn/CEX). One RPC call per holder,
// so callers must gate this behind a cooldown.
export async function holderEntryReport(mint, { getTokenAccounts, getWalletSwaps, topN = 20, pages = 1, solPriceUsd = 150, excluded = new Set() } = {}) {
  const ownerMap = ownersFromTokenAccounts([await getTokenAccounts(mint)]);
  const ranked = [...ownerMap.entries()]
    .filter(([o]) => !excluded.has(o))
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  if (!ranked.length) return { rows: [], ranked: 0 };

  const total = ranked.reduce((s, [, amt]) => s + amt, 0) || 1;
  const rows = [];
  for (const [owner, amt] of ranked) {
    let trades = [];
    try {
      const raw = await getWalletSwaps(owner, pages);
      trades = (raw || []).map(tx => parseSwap(tx, solPriceUsd)).filter(Boolean);
    } catch { /* leaves this holder unpriced */ }
    rows.push({ owner, share: amt / total, entry: avgEntryForMint(trades, mint) });
  }
  return { rows, ranked: ranked.length };
}

// One pass over the tracked wallets: fetch recent swaps, baseline on first sight,
// then alert on any first-time buy. Separate from the token loop so copy-trade
// alpha (which decays fastest) isn't stuck behind slower token scans.
export async function walletPassOnce(env, cfg, state, client, now = Math.floor(Date.now() / 1000), scan = scanToken) {
  if (!state.signalsOn || !state.whales.length) return [];
  const solPriceUsd = state.solPriceUsd || 150;
  const sinceTs = now - cfg.signalLookbackMin * 60;
  const fired = [];
  for (const w of state.whales) {
    let raw;
    try { raw = await client.walletSwaps(w.wallet, cfg.signalSwapPages); } catch { continue; }
    const trades = (raw || []).map(tx => {
      const t = parseSwap(tx, solPriceUsd);
      return t ? { ...t, signature: tx.signature || "" } : null;
    }).filter(Boolean);
    if (!trades.length) continue;

    const seen = state.walletSeen.get(w.wallet);
    if (!seen) { state.walletSeen.set(w.wallet, seedSeenMints(trades)); continue; } // baseline, no alerts

    const firsts = detectFirstBuys(trades, seen, { sinceTs, minUsd: cfg.signalMinUsd });
    for (const t of trades) seen.add(t.mint); // update history regardless
    for (const b of firsts) {
      const who = w.label || short(w.wallet);
      let sc = null;
      try { sc = await scan(b.mint, { heliusKey: env.HELIUS_API_KEY, smartMoney: state.smartMoney, flagged: state.flaggedSet }); } catch { /* signal still worth sending */ }
      if (!state.muted) await tgReply(env, formatFirstBuy(who, b, sc)).catch(() => {});
      fired.push({ wallet: w.wallet, mint: b.mint });
    }
  }
  return fired;
}

// One pass over the FOLLOWED wallets: fetch recent swaps, baseline the seen
// signatures on first sight, then fire on every new trade — buys AND sells.
// Dedup is per transaction signature (not per mint like /signals), so each trade
// pings exactly once. followSeen is runtime-only and re-baselined on restart, so
// a redeploy never replays a wallet's backlog.
export async function followPassOnce(env, cfg, state, client, now = Math.floor(Date.now() / 1000)) {
  if (!state.followed?.length) return [];
  const solPriceUsd = state.solPriceUsd || 150;
  const sinceTs = now - cfg.followLookbackMin * 60;
  const fired = [];
  for (const w of state.followed) {
    let raw;
    try { raw = await client.walletSwaps(w.wallet, cfg.followSwapPages); } catch { continue; }
    const trades = (raw || []).map(tx => {
      const t = parseSwap(tx, solPriceUsd);
      return t ? { ...t, signature: tx.signature || "" } : null;
    }).filter(Boolean);
    if (!trades.length) continue;

    let seen = state.followSeen.get(w.wallet);
    if (!seen) { // baseline: record current signatures, no alerts
      state.followSeen.set(w.wallet, new Set(trades.map(t => t.signature).filter(Boolean)));
      continue;
    }
    const fresh = detectNewTrades(trades, seen, { sinceTs, minUsd: cfg.followMinUsd });
    for (const t of trades) if (t.signature) seen.add(t.signature); // update dedup regardless
    if (seen.size > 2000) state.followSeen.set(w.wallet, new Set(trades.map(t => t.signature).filter(Boolean))); // bound memory
    for (const t of fresh) {
      const who = w.label || short(w.wallet);
      if (!state.muted) await tgReply(env, formatTrade(who, t)).catch(() => {});
      fired.push({ wallet: w.wallet, signature: t.signature, side: t.side, mint: t.mint });
    }
  }
  return fired;
}

async function walletLoop(env, cfg, state) {
  const client = makeClient(env, fetch);
  try { state.solPriceUsd = (await client.solPrice()) || 150; } catch { state.solPriceUsd = 150; }
  for (;;) {
    if (env.HELIUS_API_KEY) {
      await walletPassOnce(env, cfg, state, client).catch(e => console.error("wallet pass error:", e.message));
      await followPassOnce(env, cfg, state, client).catch(e => console.error("follow pass error:", e.message));
    }
    await sleep(cfg.walletPollSeconds * 1000);
  }
}

async function monitorLoop(env, cfg, state) {
  for (;;) {
    await monitorOnce(env, cfg, state).catch(e => console.error("monitor error:", e.message));
    // Once-a-day portfolio digest at/after the configured UTC hour.
    const now = Date.now();
    if (!state.muted && shouldDigest(state.lastDigestDay, now, cfg.digestHour)) {
      const entries = [...state.watch].map(m => ({ snap: state.last.get(m), base: state.baseline.get(m)?.snap })).filter(e => e.snap);
      const digest = buildDigest(entries);
      if (digest) await tgReply(env, digest).catch(() => {});
      state.lastDigestDay = dayKeyOf(now);
    }
    await sleep(cfg.pollSeconds * 1000);
  }
}

export async function main(env = process.env) {
  const missing = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter(k => !env[k]);
  if (missing.length) { console.error(`Missing env: ${missing.join(", ")}`); process.exit(1); }
  const cfg = {
    file: env.WATCHLIST_FILE || "liquidity-watchlist.json",
    pollSeconds: Number(env.POLL_SECONDS) || 60,
    dropPct: Number(env.LIQ_DROP_PCT) || 15,
    volDropPct: Number(env.VOL_DROP_PCT) || 40,
    holderDropPct: Number(env.HOLDER_DROP_PCT) || 10,
    baselineMs: (Number(env.BASELINE_MINUTES) || 30) * 60_000,
    cooldownMs: (Number(env.COOLDOWN_MINUTES) || 30) * 60_000,
    holderGrowPct: Number(env.HOLDER_GROW_PCT) || 25,
    digestHour: env.DIGEST_HOUR_UTC != null ? Number(env.DIGEST_HOUR_UTC) : 13, // ~08:00 ET
    whaleFile: env.SMART_MONEY_FILE || "smart-money.json",
    flaggedFile: env.FLAGGED_WALLETS_FILE || "flagged-wallets.json",
    discoverCooldownMs: (Number(env.DISCOVER_COOLDOWN_MINUTES) || 60) * 60_000,
    walletPollSeconds: Number(env.WALLET_POLL_SECONDS) || 45,
    signalMinUsd: Number(env.SIGNAL_MIN_USD) || 200,
    signalLookbackMin: Number(env.SIGNAL_LOOKBACK_MINUTES) || 30,
    signalSwapPages: Number(env.SIGNAL_SWAP_PAGES) || 1,
    followMinUsd: env.FOLLOW_MIN_USD != null ? Number(env.FOLLOW_MIN_USD) : 0, // 0 = every trade
    followLookbackMin: Number(env.FOLLOW_LOOKBACK_MINUTES) || 30,
    followSwapPages: Number(env.FOLLOW_SWAP_PAGES) || 1,
    entriesCooldownMs: (Number(env.ENTRIES_COOLDOWN_MINUTES) || 5) * 60_000,
    entriesSwapPages: Number(env.ENTRIES_SWAP_PAGES) || 1,
    scanEntriesTop: env.SCAN_ENTRIES_TOP != null ? Number(env.SCAN_ENTRIES_TOP) : 10,
  };
  const whales = loadWhales(cfg.whaleFile, env.SMART_MONEY_JSON);
  const flagged = loadWhales(cfg.flaggedFile, env.FLAGGED_WALLETS_JSON);
  const state = { watch: loadWatchlist(cfg.file, env.WATCH_TOKENS), last: new Map(), baseline: new Map(), cooldown: new Map(), priceAlerts: new Map(), muted: false, lastDigestDay: dayKeyOf(Date.now()), whales, smartMoney: parseSmartMoney(whales), flagged, flaggedSet: parseSmartMoney(flagged), discovering: false, lastDiscover: 0,
    followed: [], followSeen: new Map(),
    walletSeen: new Map(), signalsOn: env.SIGNALS_OFF !== "1", solPriceUsd: 0, lastEntries: 0 };
  // Restore everything saved in the pinned message — this is what makes state
  // permanent across redeploys without any dashboard setup.
  const restored = await restoreState(env, state);
  await persistState(env, state).catch(() => {}); // ensure a pinned state exists (merges env/file seeds)

  console.log(`Liquidity bot up. Watching ${state.watch.size} token(s), every ${cfg.pollSeconds}s, drop alert ≥${cfg.dropPct}%. ${state.whales.length} whale(s), ${state.flagged.length} flagged.${restored ? " (restored from pinned state)" : ""}`);
  await tgReply(env, `🧅 Liquidity watcher online — ${state.watch.size} token(s), ${state.whales.length} whale(s), ${state.flagged.length} flagged${state.followed.length ? `, 👁️ ${state.followed.length} followed` : ""}.${restored ? " ♻️ Restored your saved setup." : ""}${state.signalsOn && state.whales.length ? " 🎯 First-buy signals ON." : ""} Checking every ${cfg.pollSeconds}s. /help for commands.`).catch(() => {});
  await Promise.all([monitorLoop(env, cfg, state), commandLoop(env, cfg, state), walletLoop(env, cfg, state)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
