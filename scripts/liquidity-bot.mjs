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
import { scanToken } from "../rug-or-moon/api/scan.mjs";
import { diffScan } from "../rug-or-moon/watchlist.mjs";
import { sendTelegram } from "./whale-alerts.mjs";

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
  const emoji = { clean: "✅", caution: "⚠️", "high-risk": "🚩" }[snap.tier] || "";
  const head = `${alerts.some(a => a.level === "red") ? "🚨" : "👀"} <b>${esc(snap.symbol ? "$" + snap.symbol : short(snap.token))}</b> ${emoji}`;
  const body = alerts.map(a => `• ${esc(a.text)}`);
  return [head, ...body, `<a href="https://solscan.io/token/${snap.token}">Solscan</a> · safety ${snap.safety}/100`].join("\n");
}

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

/* ================= runtime (needs network + a real bot token) ================= */

const HELP = [
  "🧅 <b>Rug or Moon — liquidity watcher</b>",
  "I watch your tokens and ping you when liquidity drains, volume fades, holders leave, safety drops, or smart money exits.",
  "",
  "<b>/watch</b> &lt;mint&gt; — start watching a token",
  "<b>/unwatch</b> &lt;mint&gt; — stop watching",
  "<b>/list</b> — show watched tokens",
  "<b>/scan</b> &lt;mint&gt; — safety scan + entry read",
  "<b>/entry</b> &lt;mint&gt; — entry read only (NFA)",
  "<b>/mute</b> · <b>/unmute</b> — pause/resume alerts",
  "<b>/help</b> — this message",
].join("\n");

async function tgReply(env, text) { return sendTelegram(env, text, fetch, env.TELEGRAM_CHAT_ID); }

async function scanMessage(env, state, mint, withEntry) {
  const d = await scanToken(mint, { heliusKey: env.HELIUS_API_KEY });
  if (d.error) return `⚠️ ${esc(d.error)}`;
  const snap = buildSnapshot(d, mint);
  const v = { clean: "✅ Looks clean", caution: "⚠️ Caution", "high-risk": "🚩 High risk" }[d.tier] || d.tier;
  const top = (d.flags || []).filter(f => f.level !== "green").slice(0, 4).map(f => `• ${esc(f.text)}`).join("\n");
  let msg = `<b>${esc(d.market?.symbol ? "$" + d.market.symbol : short(mint))}</b> — ${d.safety}/100 · ${v}\n${top || "No red/yellow flags."}\n<a href="https://solscan.io/token/${mint}">Solscan</a>`;
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
    const d = await scanToken(arg, { heliusKey: env.HELIUS_API_KEY });
    if (d.error) return tgReply(env, `⚠️ ${esc(d.error)}`);
    const snap = buildSnapshot(d, arg);
    return tgReply(env, formatEntry(snap, entryRead(snap, state.baseline.get(arg)?.snap)));
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
    try { d = await scan(mint, { heliusKey: env.HELIUS_API_KEY }); } catch { continue; }
    if (!d || d.error) continue;
    const snap = buildSnapshot(d, mint);
    const prev = state.last.get(mint);
    const base = state.baseline.get(mint);
    if (prev) {
      let alerts = [...alertsFor(prev, snap, cfg.dropPct), ...trendAlerts(base?.snap, snap, cfg)]
        .filter(a => !onCooldown(state, mint, a.kind, cfg.cooldownMs, now));
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
  };
  const state = { watch: loadWatchlist(cfg.file, env.WATCH_TOKENS), last: new Map(), baseline: new Map(), cooldown: new Map(), muted: false };
  console.log(`Liquidity bot up. Watching ${state.watch.size} token(s), every ${cfg.pollSeconds}s, drop alert ≥${cfg.dropPct}%.`);
  await tgReply(env, `🧅 Liquidity watcher online — ${state.watch.size} token(s), checking every ${cfg.pollSeconds}s. /help for commands.`).catch(() => {});
  await Promise.all([monitorLoop(env, cfg, state), commandLoop(env, cfg, state)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
