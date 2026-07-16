// Vercel serverless endpoint: GET /api/scan?token=<mint>
//
// Gathers public on-chain facts and returns a scored result. DexScreener is
// keyless (market data); Solana RPC via Helius (mint authorities + top holders)
// runs server-side so the key never reaches the client — same pattern as
// patty-prix's api/stats.mjs. The scoring itself is the tested pure module.

import { scoreToken } from "../scoring.mjs";
import { loadSmartMoney, matchSmartMoney } from "../smart-money.mjs";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Core, testable: gather → score. `fetchFn` and `smartMoney` injectable for tests.
export async function scanToken(mint, { heliusKey, fetchFn = fetch, smartMoney } = {}) {
  if (!BASE58.test(mint)) return { error: "invalid token address" };
  const smSet = smartMoney || loadSmartMoney();

  const rpc = heliusKey
    ? async (method, params) => {
        const r = await fetchFn("https://mainnet.helius-rpc.com/?api-key=" + heliusKey, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        return r.json();
      }
    : null;

  const [pairsRes, info, largest] = await Promise.all([
    fetchFn("https://api.dexscreener.com/token-pairs/v1/solana/" + mint)
      .then(r => (r && r.ok === false ? [] : r.json())).catch(() => []),
    rpc ? rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]).catch(() => null) : null,
    rpc ? rpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]).catch(() => null) : null,
  ]);

  const market = bestMarket(pairsRes);
  const mintInfo = parseMintInfo(info);
  const holders = parseHolders(largest, market);

  // Resolve top-holder OWNERS and flag overlap with known smart money — the app's
  // differentiator. Best-effort: on any failure, alpha falls back to momentum.
  let sm = { count: 0, labels: [] };
  if (rpc && smSet.set.size) {
    try {
      const addrs = (largest?.result?.value || []).map(v => v.address).filter(Boolean).slice(0, 20);
      if (addrs.length) {
        const owners = await rpc("getMultipleAccounts", [addrs, { encoding: "jsonParsed" }])
          .then(r => (r?.result?.value || []).map(a => a?.data?.parsed?.info?.owner))
          .catch(() => []);
        sm = matchSmartMoney(owners, smSet);
      }
    } catch { /* fall back to momentum-only alpha */ }
  }

  const raw = {
    mint: mintInfo || {},
    holders,
    market,
    smartMoneyHolders: sm.count,
    smartMoneyLabels: sm.labels,
  };

  const result = scoreToken(raw);
  return {
    token: mint,
    ...result,
    smartMoneyHolders: sm.count,
    market: market && {
      priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd, volume24h: market.volume24h,
      mcap: market.mcap, dexId: market.dexId, symbol: market.symbol, name: market.name, icon: market.icon,
    },
    dataComplete: !!mintInfo, // false when no Helius key: authority checks unknown
    disclaimer: "Heuristic risk estimate from public on-chain data. Not financial advice. Always DYOR.",
  };
}

function bestMarket(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const score = p => (p.dexId === "pumpswap" ? 1e15 : 0) + (p.liquidity?.usd || 0);
  const p = pairs.reduce((a, b) => (score(b) > score(a) ? b : a));
  return {
    liquidityUsd: p.liquidity?.usd || 0,
    volume24h: p.volume?.h24 ?? 0,
    priceUsd: parseFloat(p.priceUsd) || null,
    mcap: p.marketCap ?? p.fdv ?? null,
    ageMs: p.pairCreatedAt ? Date.now() - p.pairCreatedAt : null,
    buys24h: p.txns?.h24?.buys ?? null,
    sells24h: p.txns?.h24?.sells ?? null,
    dexId: p.dexId,
    symbol: p.baseToken?.symbol,
    name: p.baseToken?.name,
    icon: p.info?.imageUrl || null,
  };
}

function parseMintInfo(info) {
  const parsed = info?.result?.value?.data?.parsed?.info;
  if (!parsed) return null;
  const decimals = parsed.decimals ?? 0;
  return {
    mintAuthority: parsed.mintAuthority ?? null,   // null = revoked (good)
    freezeAuthority: parsed.freezeAuthority ?? null,
    decimals,
    supply: Number(parsed.supply) / Math.pow(10, decimals),
  };
}

// Tag the largest token account as the LP pool ONLY when a real pool exists
// (liquidity ≥ $10k) — for liquid tokens the top account is almost always the
// LP, so counting it as an "insider" would false-flag legit projects. For
// low-liquidity tokens we do NOT exclude it: there a dominant holder is a real
// risk, and we lean toward flagging. Documented heuristic; the UI also shows raw
// top-holder figures.
function parseHolders(largest, market) {
  const vals = largest?.result?.value;
  if (!Array.isArray(vals) || !vals.length) return [];
  const sorted = [...vals].sort((a, b) => (b.uiAmount || 0) - (a.uiAmount || 0));
  const poolLikely = (market?.liquidityUsd || 0) >= 10_000;
  return sorted.map((v, i) => ({
    amount: v.uiAmount || 0,
    kind: i === 0 && poolLikely ? "pool" : "holder",
  }));
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  const token = (req.query?.token || "").trim();
  if (!token) return res.status(400).json({ error: "token query param required" });
  try {
    const result = await scanToken(token, { heliusKey: process.env.HELIUS_API_KEY });
    if (result.error) return res.status(400).json(result);
    res.setHeader("cache-control", "s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json(result);
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
