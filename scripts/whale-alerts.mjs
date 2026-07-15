// Patty Prix — Telegram whale-buy alerts.
//
// Watches a list of smart-money Solana wallets and posts to Telegram whenever
// one of them makes a fresh buy. Two-phase by design:
//
//   DISCOVERY (occasional)  scripts/whale-tracker.mjs finds + ranks the wallets:
//        node scripts/whale-tracker.mjs --json > scripts/whale-watchlist.json
//   ALERTS (frequent cron)  this script polls that watchlist cheaply and posts
//        new buys. Runs from .github/workflows/whale-alerts.yml.
//
// Splitting them keeps the cron job fast: re-scoring the whole ecosystem every
// few minutes would blow through API limits, but polling a fixed watchlist is
// a handful of calls.
//
// Env (GitHub Actions secrets):
//   HELIUS_API_KEY     — wallet swap history (required)
//   TELEGRAM_BOT_TOKEN — bot to post as (required)
//   TELEGRAM_CHAT_ID   — group/channel to post into (required)
//   BIRDEYE_API_KEY    — optional, only used to price SOL for USD sizing
//
// Options:
//   --file <path>      watchlist JSON, default scripts/whale-watchlist.json
//   --lookback <min>   only alert on buys this recent, default 15 (match cron)
//   --min-usd <n>      ignore buys smaller than this, default 500
//   --sol-price <usd>  skip the Birdeye SOL price lookup
//   --once             run a single pass (default; the workflow schedules it)
//
// Dedup is time-windowed: set --lookback equal to the cron interval so each buy
// is reported once. Under a delayed run you may rarely see a repeat or a miss —
// that's the tradeoff for staying database-free, same spirit as the scoreboard.

import { readFileSync, existsSync } from "fs";
import { pathToFileURL, fileURLToPath } from "url";
import { dirname, join } from "path";
import { makeClient, parseSwap } from "./whale-tracker.mjs";

const DEFAULT_WATCHLIST = join(dirname(fileURLToPath(import.meta.url)), "whale-watchlist.json");

/* ================================================================
   Watchlist loading — accepts several shapes
   ================================================================ */

// Accepts: ["addr", …]  |  [{wallet,label?}, …]  |  the tracker's --json output
// (array of scored objects, each with a `wallet` field). Returns [{wallet,label}].
export function normalizeWatchlist(json) {
  if (!Array.isArray(json)) throw new Error("watchlist must be a JSON array");
  return json
    .map(entry => {
      if (typeof entry === "string") return { wallet: entry, label: "" };
      if (entry && entry.wallet) return { wallet: entry.wallet, label: entry.label || "" };
      return null;
    })
    .filter(Boolean);
}

export function loadWatchlist(path) {
  if (!existsSync(path)) return null;
  return normalizeWatchlist(JSON.parse(readFileSync(path, "utf8")));
}

/* ================================================================
   Buy extraction (pure)
   ================================================================ */

// From a wallet's raw SWAP txs, return the buys that are recent enough and big
// enough to alert on, newest first, each tagged with its signature for linking.
export function recentBuys(rawTxs, { solPriceUsd, sinceTs, minUsd }) {
  const out = [];
  for (const tx of rawTxs || []) {
    const t = parseSwap(tx, solPriceUsd);
    if (!t || t.side !== "buy") continue;
    if (t.timestamp < sinceTs) continue;
    if (t.quoteUsd < minUsd) continue;
    out.push({ ...t, signature: tx.signature || "" });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/* ================================================================
   Message formatting (pure)
   ================================================================ */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function shortMint(m) { return m.slice(0, 4) + "…" + m.slice(-4); }
function usd(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? (n / 1e6).toFixed(2) + "M" : a >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(0);
  return "$" + s;
}
function ago(ts, nowTs) {
  const secs = Math.max(0, nowTs - ts);
  if (secs < 3600) return Math.max(1, Math.floor(secs / 60)) + "m";
  if (secs < 86400) return Math.floor(secs / 3600) + "h";
  return Math.floor(secs / 86400) + "d";
}
const walletLink = w => `https://solscan.io/account/${w}`;
const tokenLink = m => `https://solscan.io/token/${m}`;
const txLink = s => `https://solscan.io/tx/${s}`;

// perWallet: [{ wallet, label, buys: [...] }] — only wallets WITH buys.
// Returns an HTML string, or null when there's nothing to report.
export function buildAlert(perWallet, nowTs, maxLines = 25) {
  const active = perWallet.filter(w => w.buys.length);
  if (!active.length) return null;

  const lines = ["🐋 <b>WHALE BUYS</b>"];
  let shown = 0, truncated = false;

  for (const w of active) {
    const who = w.label ? esc(w.label) : shortMint(w.wallet);
    lines.push(`\n<a href="${walletLink(w.wallet)}">${who}</a>`);
    for (const b of w.buys) {
      if (shown >= maxLines) { truncated = true; break; }
      const tok = `<a href="${tokenLink(b.mint)}">${shortMint(b.mint)}</a>`;
      const sig = b.signature ? ` · <a href="${txLink(b.signature)}">tx</a>` : "";
      lines.push(`  • bought ${tok} ${usd(b.quoteUsd)} · ${ago(b.timestamp, nowTs)} ago${sig}`);
      shown++;
    }
    if (truncated) break;
  }
  if (truncated) lines.push("\n…more buys not shown");
  return lines.join("\n");
}

/* ================================================================
   Telegram
   ================================================================ */

// chatId defaults to env.TELEGRAM_CHAT_ID so existing callers are unchanged;
// pass an explicit id (e.g. NEWSLETTER_CHAT_ID) to target a different group.
export async function sendTelegram(env, text, fetchFn = fetch, chatId = env.TELEGRAM_CHAT_ID) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  return res.json();
}

/* ================================================================
   Orchestration
   ================================================================ */

export function parseArgs(argv) {
  const flag = n => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    file: flag("file") || DEFAULT_WATCHLIST,
    lookbackMin: flag("lookback") != null ? Number(flag("lookback")) : 15,
    minUsd: flag("min-usd") != null ? Number(flag("min-usd")) : 500,
    solPriceUsd: flag("sol-price") != null ? Number(flag("sol-price")) : 0,
  };
}

// nowTs injectable for deterministic tests.
export async function gatherBuys(watchlist, client, cfg, nowTs) {
  const solPriceUsd = cfg.solPriceUsd || (await client.solPrice().catch(() => 0)) || 150;
  const sinceTs = nowTs - cfg.lookbackMin * 60;
  const perWallet = [];
  for (const w of watchlist) {
    const raw = await client.walletSwaps(w.wallet, 1);
    const buys = recentBuys(raw, { solPriceUsd, sinceTs, minUsd: cfg.minUsd });
    perWallet.push({ ...w, buys });
  }
  return { perWallet, solPriceUsd };
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchFn = fetch, nowTs = Math.floor(Date.now() / 1000)) {
  const cfg = parseArgs(argv);

  const missing = ["HELIUS_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter(k => !env[k]);
  if (missing.length) {
    console.log(`Missing secrets (${missing.join(", ")}) — skipping. Set them to enable whale alerts.`);
    return;
  }

  const watchlist = loadWatchlist(cfg.file);
  if (!watchlist || !watchlist.length) {
    console.log(`No watchlist at ${cfg.file}. Generate one:\n` +
      `  node scripts/whale-tracker.mjs --json > scripts/whale-watchlist.json`);
    return;
  }

  const client = makeClient(env, fetchFn);
  const { perWallet } = await gatherBuys(watchlist, client, cfg, nowTs);
  const text = buildAlert(perWallet, nowTs);

  if (!text) {
    console.log(`No new buys in the last ${cfg.lookbackMin}m across ${watchlist.length} wallets.`);
    return;
  }
  const sent = await sendTelegram(env, text, fetchFn);
  console.log(sent.ok
    ? `Posted whale alert (${perWallet.reduce((n, w) => n + w.buys.length, 0)} buys).`
    : `sendMessage failed: ${sent.description}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
