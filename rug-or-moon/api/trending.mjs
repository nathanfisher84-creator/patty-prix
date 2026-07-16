// Vercel serverless endpoint: GET /api/trending
//
// Auto-scans today's trending Solana tokens so the app opens to a ready-made
// "safe gems vs rugs" board instead of a blank search box. Sources the trending
// list (Birdeye if BIRDEYE_API_KEY is set, else DexScreener's keyless boosted
// list), then runs each through the same tested scanToken() pipeline.

import { scanToken } from "./scan.mjs";
import { loadSmartMoney } from "../smart-money.mjs";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Core, testable: gather trending mints → scan each. Backends injectable.
export async function scanTrending({ limit = 12, heliusKey, birdeyeKey, fetchFn = fetch, smartMoney, concurrency = 4 } = {}) {
  const smSet = smartMoney || loadSmartMoney();
  const mints = await trendingMints({ limit, birdeyeKey, fetchFn });
  if (!mints.length) return { tokens: [], source: "none", generatedAt: null };

  // Scan in small waves so we don't hammer the RPC or trip rate limits.
  const scanned = [];
  for (let i = 0; i < mints.length; i += concurrency) {
    const wave = mints.slice(i, i + concurrency);
    const results = await Promise.all(wave.map(m =>
      scanToken(m.mint, { heliusKey, fetchFn, smartMoney: smSet })
        .then(r => (r && !r.error ? { ...r, trendingRank: m.rank } : null))
        .catch(() => null)));
    scanned.push(...results.filter(Boolean));
  }

  // Sort: safest-with-alpha first. Gems (clean + smart money / momentum) rise;
  // rugs sink but stay visible — the "avoid these" half of the board.
  scanned.sort((a, b) => board(b) - board(a));
  return {
    tokens: scanned,
    source: birdeyeKey ? "birdeye" : "dexscreener",
    count: scanned.length,
  };
}

// A single sortable score so the board reads gems→rugs. Safety dominates; alpha
// breaks ties among the safe ones.
function board(t) {
  return (t.safety ?? 0) * 2 + (t.alpha?.score ?? 0);
}

// Resolve trending mints from whichever source is available.
async function trendingMints({ limit, birdeyeKey, fetchFn }) {
  if (birdeyeKey) {
    const viaBirdeye = await birdeyeTrending({ limit, birdeyeKey, fetchFn }).catch(() => []);
    if (viaBirdeye.length) return viaBirdeye;
  }
  return dexscreenerTrending({ limit, fetchFn }).catch(() => []);
}

async function birdeyeTrending({ limit, birdeyeKey, fetchFn }) {
  const url = `https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=${limit}`;
  const r = await fetchFn(url, { headers: { "X-API-KEY": birdeyeKey, "x-chain": "solana", accept: "application/json" } });
  if (r && r.ok === false) return [];
  const j = await r.json();
  const list = j?.data?.tokens || j?.data?.items || [];
  return list
    .map((t, i) => ({ mint: t.address || t.mint, rank: t.rank ?? i + 1 }))
    .filter(t => BASE58.test(t.mint || ""))
    .slice(0, limit);
}

// Keyless fallback: DexScreener's "boosted" tokens are a decent proxy for what's
// being pushed/trending right now. Dedupe by mint, Solana only.
async function dexscreenerTrending({ limit, fetchFn }) {
  const r = await fetchFn("https://api.dexscreener.com/token-boosts/top/v1");
  if (r && r.ok === false) return [];
  const j = await r.json();
  const seen = new Set();
  const out = [];
  for (const b of Array.isArray(j) ? j : []) {
    if (b.chainId !== "solana") continue;
    const mint = b.tokenAddress;
    if (!mint || seen.has(mint) || !BASE58.test(mint)) continue;
    seen.add(mint);
    out.push({ mint, rank: out.length + 1 });
    if (out.length >= limit) break;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  const limit = Math.min(20, Math.max(1, parseInt(req.query?.limit, 10) || 12));
  try {
    const result = await scanTrending({
      limit,
      heliusKey: process.env.HELIUS_API_KEY,
      birdeyeKey: process.env.BIRDEYE_API_KEY,
    });
    res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json(result);
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
