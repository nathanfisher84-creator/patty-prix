// Patty Prix — Telegram pinned live scoreboard.
//
// Fetches the same DexScreener data as the website, renders the race as a
// text scoreboard, and keeps a pinned Telegram message up to date:
//   - if the chat's pinned message is ours → edit it in place
//   - otherwise → post a fresh scoreboard and pin it
//
// Runs from .github/workflows/telegram-scoreboard.yml on a schedule.
// Needs two GitHub Actions secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// The bot must be a group admin with the "Pin messages" right.

import { pathToFileURL } from "url";

// Keep these addresses in sync with the CONFIG block in index.html.
export const CONFIG = {
  challenger: "2jz9E5JrEbxLg1RhU68aaSikDvpQurCEZz9BBF9rpump",
  rivals: [
    "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
    "6baGyq4HLbUn93MQUGFqBktpXP8BRjpoxSsAap4ppump",
    "CFPkPq1eYPR8GLzEo59wUbbMioX4bshaTQiSGzTSpump",
    "5pYB12kEhfhSFXJjZ7JtyqDpt6uUqhsF6iu6Ee9spump",
    "DdPrHYqM8Ueovnk9kAnAgoGhswkuaTqmxcoZzU3Zpump",
    "4U4U8oXwDyVXGeTffMXds4NAgBgLFwq3wNvTCRTSpump",
    "9E2Q4KKxLS5Y4bu6RKvjg5wQ2kzaLkiVsMt7zwMZpump",
    "a3W4qutoEJA4232T2gwZUfgYJTetr96pU4SJMwppump",
    "BWH6gtE5MSCS1GUoRpM5HrqQnV97oi8g8dDHAi41pump"
  ],
  siteUrl: "https://pattyprix.xyz/"
};

// token-pairs returns ALL pools of a token; the batch /tokens/v1
// endpoint returns a single pair per token and can pick a stale
// graduated bonding-curve listing over the live PumpSwap pool.
const API = "https://api.dexscreener.com/token-pairs/v1/solana/";

export async function fetchAllPairs(fetchFn = fetch) {
  const all = [CONFIG.challenger, ...CONFIG.rivals];
  const results = await Promise.all(all.map(a =>
    fetchFn(API + a).then(r => (r && r.ok === false ? [] : r.json())).catch(() => [])
  ));
  return results.flat();
}

// PumpSwap pools take priority (most liquid one if several); most
// liquid pool on any DEX is the fallback for tokens without one.
function pairScore(p) {
  return (p.dexId === "pumpswap" ? 1e15 : 0) + (p.liquidity?.usd || 0);
}
export function bestPairs(pairs, addresses) {
  const map = {};
  const wanted = new Set(addresses.map(a => a.toLowerCase()));
  for (const p of pairs || []) {
    const addr = p.baseToken?.address?.toLowerCase();
    if (!addr || !wanted.has(addr)) continue;
    if (!map[addr] || pairScore(p) > pairScore(map[addr])) map[addr] = p;
  }
  return map;
}

export function fmtUsd(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

export function fmtMult(x) {
  if (x >= 1000) return Math.round(x).toLocaleString() + "x";
  if (x >= 100) return Math.round(x) + "x";
  if (x >= 10) return x.toFixed(0) + "x";
  return x.toFixed(1) + "x";
}

export function bar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "🟦".repeat(filled) + "⬜".repeat(10 - filled);
}

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildMessage(byAddr, now = new Date()) {
  const me = byAddr[CONFIG.challenger.toLowerCase()];
  const myMcap = me && (me.marketCap ?? me.fdv);
  if (!myMcap) throw new Error("Challenger token not found on DexScreener");

  const rows = [];
  for (const addr of CONFIG.rivals) {
    const p = byAddr[addr.toLowerCase()];
    const mcap = p && (p.marketCap ?? p.fdv);
    if (!mcap) continue;
    rows.push({
      name: p.baseToken.name || p.baseToken.symbol,
      symbol: p.baseToken.symbol,
      mcap,
      pct: Math.min(myMcap / mcap * 100, 100),
      mult: mcap / myMcap
    });
  }
  rows.sort((a, b) => b.pct - a.pct);

  const lines = [
    "🏁 <b>PATTY PRIX — LIVE RACE</b>",
    `<b>${esc(me.baseToken.name)}</b> ($${esc(me.baseToken.symbol)}) · MCAP ${fmtUsd(myMcap)}`,
    ""
  ];
  for (const r of rows) {
    if (r.pct >= 100) {
      lines.push(`👑 <b>${esc(r.name)}</b> ($${esc(r.symbol)}) — FLIPPED!`);
    } else {
      lines.push(`${bar(r.pct)} ${r.pct.toFixed(1)}%`);
      lines.push(`<b>${esc(r.name)}</b> ($${esc(r.symbol)}) · ${fmtUsd(r.mcap)} · ${fmtMult(r.mult)} to go`);
    }
    lines.push("");
  }
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  lines.push(`⏱ ${hh}:${mm} UTC · <a href="${CONFIG.siteUrl}">full dashboard</a>`);
  return lines.join("\n");
}

export async function main(env = process.env, fetchFn = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets not set — skipping.");
    return;
  }

  const tg = async (method, params) => {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params)
    });
    return res.json();
  };

  const all = [CONFIG.challenger, ...CONFIG.rivals];
  const pairs = await fetchAllPairs(fetchFn);
  if (!pairs.length) throw new Error("DexScreener returned no pairs");
  const byAddr = bestPairs(pairs, all);
  const text = buildMessage(byAddr);
  const opts = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };

  const [meBot, chat] = await Promise.all([tg("getMe", {}), tg("getChat", { chat_id: chatId })]);
  const pinned = chat?.result?.pinned_message;

  if (pinned && pinned.from?.id === meBot?.result?.id) {
    const edit = await tg("editMessageText", { ...opts, message_id: pinned.message_id });
    if (edit.ok || /not modified/i.test(edit.description || "")) {
      console.log("Scoreboard updated (message " + pinned.message_id + ").");
      return;
    }
    console.log("Edit failed (" + edit.description + ") — posting a fresh scoreboard.");
  }

  const sent = await tg("sendMessage", opts);
  if (!sent.ok) throw new Error("sendMessage failed: " + sent.description);
  const pin = await tg("pinChatMessage", {
    chat_id: chatId,
    message_id: sent.result.message_id,
    disable_notification: true
  });
  console.log(pin.ok
    ? "Posted and pinned a new scoreboard."
    : "Posted the scoreboard but couldn't pin it — make the bot an admin with the 'Pin messages' right. (" + pin.description + ")");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
