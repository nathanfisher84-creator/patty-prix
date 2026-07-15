// Patty Prix — daily Solana research agent → Telegram newsletter.
//
// Ties together everything the other scripts do into one daily briefing:
//   • trending tokens                 (Birdeye)
//   • biggest 24h gainers / losers    (Birdeye)
//   • smart-money wallets + PnL        (whale-tracker: discover + score)
//   • WHERE smart money is going       (consensus — tokens multiple whales bought)
//   • a written intro                  (Claude when ANTHROPIC_API_KEY is set,
//                                        deterministic template otherwise)
// …then posts the edition to Telegram. Runs from
// .github/workflows/research-newsletter.yml on a daily schedule.
//
// Env (GitHub Actions secrets):
//   HELIUS_API_KEY      — smart-money discovery + scoring (required)
//   BIRDEYE_API_KEY     — trending / gainers / losers / SOL price (required)
//   TELEGRAM_BOT_TOKEN  — bot to post as (required unless --dry)
//   TELEGRAM_CHAT_ID    — group/channel to post into (required unless --dry)
//   ANTHROPIC_API_KEY   — optional; enables the Claude-written narrative
//   ANTHROPIC_MODEL     — optional; defaults to claude-opus-4-8
//
// Options:
//   --dry            build + print the newsletter, don't post to Telegram
//   --out <file>     also write the Markdown edition to a file
//   --trending <n>   trending tokens to scan for whales, default 10
//   --candidates <n> max whale suspects to score, default 40
//   --min-pnl <usd>  smart-money PnL floor, default 5000
//   --min-winrate <pct>  smart-money win-rate floor, default 55
//   --min-trades <n> smart-money closed-trade floor, default 6
//   --consensus <n>  min whales buying a token to call it consensus, default 2
//   --top <n>        rows per section, default 5
//
// NOTE: needs live network (Helius, Birdeye, Telegram, api.anthropic.com) —
// run it locally or on GitHub Actions, not in a restricted sandbox.

import { writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { makeClient, discoverSmartMoney } from "./whale-tracker.mjs";
import { sendTelegram } from "./whale-alerts.mjs";

/* ================================================================
   Market data (Birdeye) — injectable fetch for tests
   ================================================================ */

// Tolerant parse: trending and tokenlist responses share item fields but not
// exact names, so fall back across the variants (same defensive style as
// api/stats.mjs's `holder ?? holders`).
export function parseMarketTokens(json, limit = 10) {
  const items = json?.data?.tokens || json?.data?.items || [];
  return items
    .map(t => ({
      address: t.address,
      symbol: t.symbol || (t.address ? t.address.slice(0, 4) : "?"),
      price: Number(t.price) || null,
      change24h: Number(
        t.price24hChangePercent ?? t.v24hChangePercent ?? t.priceChange24hPercent ?? t.change24h
      ) || 0,
      mcap: Number(t.mc ?? t.marketCap ?? t.marketcap) || null,
    }))
    .filter(t => t.address)
    .slice(0, limit);
}

export function makeMarketClient(env, fetchFn = fetch) {
  const key = env.BIRDEYE_API_KEY;
  const bird = async path => {
    const r = await fetchFn("https://public-api.birdeye.so" + path, {
      headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" },
    });
    return r.json();
  };
  return {
    async trending(limit) {
      return parseMarketTokens(
        await bird(`/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=${limit}`), limit);
    },
    async movers(limit, minLiq = 50_000) {
      const [g, l] = await Promise.all([
        bird(`/defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=${limit}&min_liquidity=${minLiq}`),
        bird(`/defi/tokenlist?sort_by=v24hChangePercent&sort_type=asc&offset=0&limit=${limit}&min_liquidity=${minLiq}`),
      ]);
      return { gainers: parseMarketTokens(g, limit), losers: parseMarketTokens(l, limit) };
    },
  };
}

/* ================================================================
   Consensus — where multiple whales are putting money (pure)
   ================================================================ */

// Aggregate the smart-money wallets' recent buys by token. A token that N
// distinct whales bought is a stronger signal than any single big buy — this
// is the newsletter's headline section.
export function consensusBuys(smart, { minWallets = 2 } = {}) {
  const byMint = new Map();
  for (const w of smart) {
    for (const b of w.recentBuys || []) {
      const e = byMint.get(b.mint) || { mint: b.mint, wallets: new Set(), totalUsd: 0 };
      e.wallets.add(w.wallet);
      e.totalUsd += b.quoteUsd;
      byMint.set(b.mint, e);
    }
  }
  return [...byMint.values()]
    .map(e => ({ mint: e.mint, walletCount: e.wallets.size, totalUsd: e.totalUsd }))
    .filter(e => e.walletCount >= minWallets)
    .sort((a, b) => b.walletCount - a.walletCount || b.totalUsd - a.totalUsd);
}

/* ================================================================
   Narrative — Claude when available, deterministic template otherwise
   ================================================================ */

function templateIntro(d) {
  const parts = [];
  parts.push(`SOL is trading around ${usd(d.solPriceUsd)}.`);
  if (d.consensus[0]) {
    const c = d.consensus[0];
    parts.push(`Smart money is clustering into ${sym(d, c.mint)} — ${c.walletCount} tracked whales bought, ${usd(c.totalUsd)} in total.`);
  } else {
    parts.push(`No clear smart-money consensus today — the tracked whales aren't crowding into any one token.`);
  }
  if (d.gainers[0]) parts.push(`The day's top mover is ${d.gainers[0].symbol} (${pct(d.gainers[0].change24h)}).`);
  return parts.join(" ");
}

// Raw fetch to the Messages API — the whole repo calls every external service
// (Telegram, Helius, Birdeye) with built-in fetch and ships no package.json, so
// the Claude call follows the same zero-dependency pattern instead of the SDK.
export async function writeNarrative(d, env, fetchFn = fetch) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { text: templateIntro(d), byClaude: false };

  const facts = {
    solPriceUsd: round2(d.solPriceUsd),
    trending: d.trending.slice(0, 5).map(t => ({ symbol: t.symbol, change24h: round2(t.change24h) })),
    topGainers: d.gainers.slice(0, 3).map(t => ({ symbol: t.symbol, change24h: round2(t.change24h) })),
    topLosers: d.losers.slice(0, 3).map(t => ({ symbol: t.symbol, change24h: round2(t.change24h) })),
    smartMoneyWallets: d.smart.length,
    consensusBuys: d.consensus.slice(0, 3).map(c => ({ token: sym(d, c.mint), whales: c.walletCount, usd: Math.round(c.totalUsd) })),
  };
  const prompt =
    "You are the analyst writing the intro for 'Patty Prix Daily', a Solana on-chain market briefing.\n" +
    "Write a punchy 2-3 sentence intro from ONLY the data below. Lead with the most interesting signal " +
    "(usually the smart-money consensus). No hype, no emojis, no financial advice, no invented numbers. " +
    "Plain prose, no headings.\n\nDATA:\n" + JSON.stringify(facts, null, 2);

  try {
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 400,
        // Simple summarization: keep thinking off so the whole 400-token budget
        // goes to the intro. On Sonnet 5 adaptive thinking is ON by default when
        // `thinking` is omitted, which would otherwise risk truncating the intro.
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = await res.json();
    const text = (json?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    return text ? { text, byClaude: true } : { text: templateIntro(d), byClaude: false };
  } catch {
    return { text: templateIntro(d), byClaude: false };
  }
}

/* ================================================================
   Formatting helpers
   ================================================================ */

function usd(n) {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  if (a > 0 && a < 1) return "$" + n.toPrecision(2);
  return "$" + n.toFixed(0);
}
function pct(n) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; }
function shortMint(m) { return m.slice(0, 4) + "…" + m.slice(-4); }
function sym(d, mint) { return d.symbolByMint.get(mint) || shortMint(mint); }
function round2(n) { return Math.round(n * 100) / 100; }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ================================================================
   Newsletter (Markdown) + Telegram (HTML) — pure
   ================================================================ */

export function buildNewsletter(d, top = 5) {
  const L = [];
  L.push(`# 🏁 Patty Prix Daily — ${d.date}`);
  L.push("");
  L.push(d.narrative);
  L.push("");
  L.push(`**Market:** SOL ${usd(d.solPriceUsd)} · scanned ${d.scannedTokens} trending tokens · ${d.smart.length} smart-money wallets`);
  L.push("");

  L.push("## 🎯 Where smart money is going");
  if (d.consensus.length) {
    for (const c of d.consensus.slice(0, top)) {
      L.push(`- **${sym(d, c.mint)}** — ${c.walletCount} whales buying · ${usd(c.totalUsd)}`);
    }
  } else {
    L.push("_No multi-whale consensus today._");
  }
  L.push("");

  L.push("## 🐋 Smart money");
  if (d.smart.length) {
    for (const s of d.smart.slice(0, top)) {
      L.push(`- \`${shortMint(s.wallet)}\` — PnL ${usd(s.realizedUsd)} · win ${(s.winRate * 100).toFixed(0)}% · ${s.closedTrades} trades`);
    }
  } else {
    L.push("_No wallets cleared the smart-money filters today._");
  }
  L.push("");

  L.push("## 🔥 Trending");
  for (const t of d.trending.slice(0, top)) L.push(`- ${t.symbol} · ${pct(t.change24h)} 24h`);
  L.push("");

  L.push("## 📈 Biggest gainers (24h)");
  for (const t of d.gainers.slice(0, top)) L.push(`- ${t.symbol} · ${pct(t.change24h)}`);
  L.push("");
  L.push("## 📉 Biggest losers (24h)");
  for (const t of d.losers.slice(0, top)) L.push(`- ${t.symbol} · ${pct(t.change24h)}`);
  L.push("");

  L.push("---");
  L.push("_On-chain data via Helius & Birdeye. Not financial advice — pseudonymous wallet activity, do your own research._");
  return L.join("\n");
}

export function buildTelegram(d, top = 4) {
  const L = [];
  L.push(`🏁 <b>PATTY PRIX DAILY</b> — ${esc(d.date)}`);
  L.push("");
  L.push(esc(d.narrative));
  L.push("");
  L.push("🎯 <b>Where smart money is going</b>");
  if (d.consensus.length) {
    for (const c of d.consensus.slice(0, top)) {
      L.push(`• <a href="https://solscan.io/token/${c.mint}">${esc(sym(d, c.mint))}</a> — ${c.walletCount} whales · ${usd(c.totalUsd)}`);
    }
  } else {
    L.push("• no multi-whale consensus today");
  }
  L.push("");
  if (d.gainers[0] || d.losers[0]) {
    const g = d.gainers[0], l = d.losers[0];
    L.push(`📈 top gainer ${g ? esc(g.symbol) + " " + pct(g.change24h) : "—"}  ·  📉 top loser ${l ? esc(l.symbol) + " " + pct(l.change24h) : "—"}`);
    L.push("");
  }
  L.push(`SOL ${usd(d.solPriceUsd)} · ${d.smart.length} smart-money wallets tracked · <a href="https://pattyprix.xyz/">pattyprix.xyz</a>`);
  return L.join("\n");
}

/* ================================================================
   Orchestration
   ================================================================ */

export function parseArgs(argv) {
  const flag = n => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (n, dflt) => (flag(n) != null ? Number(flag(n)) : dflt);
  return {
    dry: argv.includes("--dry"),
    out: flag("out") || null,
    trending: num("trending", 10),
    candidates: num("candidates", 40),
    minPnl: num("min-pnl", 5000),
    minWinRate: num("min-winrate", 55),
    minTrades: num("min-trades", 6),
    consensus: num("consensus", 2),
    top: num("top", 5),
  };
}

// nowDate injectable so tests are deterministic (Date.* is fine at runtime).
export async function gather(cfg, env, fetchFn, nowDate) {
  const market = makeMarketClient(env, fetchFn);
  const client = makeClient(env, fetchFn);

  const [trending, movers, discovery] = await Promise.all([
    market.trending(cfg.top + 3),
    market.movers(cfg.top),
    discoverSmartMoney({
      trending: cfg.trending, holderPages: 1, perToken: 20, maxCandidates: cfg.candidates,
      swapPages: 2, minPnlUsd: cfg.minPnl, minWinRatePct: cfg.minWinRate, minTrades: cfg.minTrades,
      limit: 25, solPriceUsd: 0,
    }, client, msg => console.error(msg)),
  ]);

  const d = {
    date: nowDate,
    solPriceUsd: discovery.solPriceUsd,
    scannedTokens: discovery.scannedTokens,
    symbolByMint: discovery.symbolByMint,
    smart: discovery.smart,
    trending,
    gainers: movers.gainers,
    losers: movers.losers,
    consensus: consensusBuys(discovery.smart, { minWallets: cfg.consensus }),
  };
  return d;
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchFn = fetch,
                           nowDate = new Date().toISOString().slice(0, 10)) {
  const cfg = parseArgs(argv);

  const need = ["HELIUS_API_KEY", "BIRDEYE_API_KEY"];
  if (!cfg.dry) need.push("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID");
  const missing = need.filter(k => !env[k]);
  if (missing.length) {
    console.log(`Missing secrets (${missing.join(", ")}) — skipping. (Use --dry to build without Telegram.)`);
    return;
  }

  const d = await gather(cfg, env, fetchFn, nowDate);
  const narr = await writeNarrative(d, env, fetchFn);
  d.narrative = narr.text;
  console.error(`Narrative: ${narr.byClaude ? "Claude-written" : "template fallback"}`);

  const markdown = buildNewsletter(d, cfg.top);
  if (cfg.out) { writeFileSync(cfg.out, markdown); console.error(`Wrote ${cfg.out}`); }

  if (cfg.dry) { console.log("\n" + markdown + "\n"); return; }

  const sent = await sendTelegram(env, buildTelegram(d, cfg.top), fetchFn);
  console.log(sent.ok ? "Posted the daily newsletter to Telegram." : `sendMessage failed: ${sent.description}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
