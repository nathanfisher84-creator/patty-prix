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
import { discoverSmartMoney, makeClient } from "./whale-tracker.mjs";

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
  if (c === "/mute") return { cmd: "mute" };
  if (c === "/unmute") return { cmd: "unmute" };
  if (c === "/help" || c === "/start") return { cmd: "help" };
  return { cmd: "unknown", raw: t };
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
  "<b>/mute</b> · <b>/unmute</b> — pause/resume alerts",
  "<b>/help</b> — this message",
].join("\n");

async function tgReply(env, text) { return sendTelegram(env, text, fetch, env.TELEGRAM_CHAT_ID); }

async function scanMessage(env, state, mint, withEntry) {
  // Deployer lookup runs in parallel with the scan (it's a couple of extra RPC
  // calls, so on-demand only — never in the fast monitor loop).
  const [d, deployer] = await Promise.all([
    scanToken(mint, { heliusKey: env.HELIUS_API_KEY, smartMoney: state.smartMoney, flagged: state.flaggedSet }),
    findDeployer(mint, { heliusKey: env.HELIUS_API_KEY }).catch(() => null),
  ]);
  if (d.error) return `⚠️ ${esc(d.error)}`;
  const snap = buildSnapshot(d, mint);
  const v = { clean: "✅ Looks clean", caution: "⚠️ Caution", "high-risk": "🚩 High risk" }[d.tier] || d.tier;
  const top = (d.flags || []).filter(f => f.level !== "green").slice(0, 4).map(f => `• ${esc(f.text)}`).join("\n");
  const holders = formatHolders(d.topHolders, deployer);
  let msg = `<b>${esc(d.market?.symbol ? "$" + d.market.symbol : short(mint))}</b> — ${d.safety}/100 · ${v}\n${top || "No red/yellow flags."}`;
  if (holders) msg += "\n" + holders;
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
    return tgReply(env, await scanMessage(env, state, arg, true));
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
        await handleCommand(env, cfg, state, msg.text || "").catch(e => console.error("cmd error:", e.message));
      }
    } catch (e) { console.error("getUpdates error:", e.message); await sleep(3000); }
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
  };
  const whales = loadWhales(cfg.whaleFile, env.SMART_MONEY_JSON);
  const flagged = loadWhales(cfg.flaggedFile, env.FLAGGED_WALLETS_JSON);
  const state = { watch: loadWatchlist(cfg.file, env.WATCH_TOKENS), last: new Map(), baseline: new Map(), cooldown: new Map(), priceAlerts: new Map(), muted: false, lastDigestDay: dayKeyOf(Date.now()), whales, smartMoney: parseSmartMoney(whales), flagged, flaggedSet: parseSmartMoney(flagged), discovering: false, lastDiscover: 0 };
  console.log(`Liquidity bot up. Watching ${state.watch.size} token(s), every ${cfg.pollSeconds}s, drop alert ≥${cfg.dropPct}%. ${state.whales.length} whale(s), ${state.flagged.length} flagged.`);
  await tgReply(env, `🧅 Liquidity watcher online — ${state.watch.size} token(s), checking every ${cfg.pollSeconds}s.${state.flagged.length ? ` 🚩 ${state.flagged.length} flagged wallet(s).` : ""} /help for commands.`).catch(() => {});
  await Promise.all([monitorLoop(env, cfg, state), commandLoop(env, cfg, state)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
