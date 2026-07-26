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
    liqQuote: d.market?.meteoraQuote ?? d.market?.liqQuote ?? null,
    liquidityUsd: d.market?.liquidityUsd ?? null,
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
  "I watch your tokens and ping you when liquidity drains, safety drops, or smart money exits.",
  "",
  "<b>/watch</b> &lt;mint&gt; — start watching a token",
  "<b>/unwatch</b> &lt;mint&gt; — stop watching",
  "<b>/list</b> — show watched tokens",
  "<b>/scan</b> &lt;mint&gt; — one-off safety scan",
  "<b>/help</b> — this message",
].join("\n");

async function tgReply(env, text) { return sendTelegram(env, text, fetch, env.TELEGRAM_CHAT_ID); }

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
    const d = await scanToken(arg, { heliusKey: env.HELIUS_API_KEY });
    if (d.error) return tgReply(env, `⚠️ ${esc(d.error)}`);
    const v = { clean: "✅ Looks clean", caution: "⚠️ Caution", "high-risk": "🚩 High risk" }[d.tier] || d.tier;
    const top = (d.flags || []).filter(f => f.level !== "green").slice(0, 4).map(f => `• ${esc(f.text)}`).join("\n");
    return tgReply(env, `<b>${esc(d.market?.symbol ? "$" + d.market.symbol : short(arg))}</b> — ${d.safety}/100 · ${v}\n${top || "No red/yellow flags."}\n<a href="https://solscan.io/token/${arg}">Solscan</a>`);
  }
  return tgReply(env, "Unknown command. /help");
}

// One monitoring pass: scan each watched token, diff vs its in-memory baseline,
// alert on anything notable, then store the new baseline.
export async function monitorOnce(env, cfg, state, scan = scanToken) {
  for (const mint of state.watch) {
    let d;
    try { d = await scan(mint, { heliusKey: env.HELIUS_API_KEY }); } catch { continue; }
    if (!d || d.error) continue;
    const snap = buildSnapshot(d, mint);
    const prev = state.last.get(mint);
    if (prev) {
      const alerts = alertsFor(prev, snap, cfg.dropPct);
      if (alerts.length) await tgReply(env, formatAlert(snap, alerts));
    }
    state.last.set(mint, snap); // new baseline (first pass just baselines)
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
  };
  const state = { watch: loadWatchlist(cfg.file, env.WATCH_TOKENS), last: new Map() };
  console.log(`Liquidity bot up. Watching ${state.watch.size} token(s), every ${cfg.pollSeconds}s, drop alert ≥${cfg.dropPct}%.`);
  await tgReply(env, `🧅 Liquidity watcher online — ${state.watch.size} token(s), checking every ${cfg.pollSeconds}s. /help for commands.`).catch(() => {});
  await Promise.all([monitorLoop(env, cfg, state), commandLoop(env, cfg, state)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
