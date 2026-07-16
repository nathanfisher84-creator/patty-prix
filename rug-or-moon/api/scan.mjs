// Vercel serverless endpoint: GET /api/scan?token=<mint>
//
// Gathers public on-chain facts and returns a scored result. DexScreener is
// keyless (market data); Solana RPC via Helius (mint authorities + top holders)
// runs server-side so the key never reaches the client — same pattern as
// patty-prix's api/stats.mjs. The scoring itself is the tested pure module.

import { scoreToken } from "../scoring.mjs";
import { loadSmartMoney, matchSmartMoney } from "../smart-money.mjs";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Owners that are NOT insiders — classify holders by OWNER, never by "biggest
// account is the pool" (that hid a dev whale larger than the LP). Unrecognized
// pools fall through to being counted (safe direction: over-warn, never
// false-clean); scoring adds a "verify on Solscan" hint in that case.
const POOL_OWNERS = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j", // Raydium AMM v4 authority (base/quote vaults)
  // Extend with other AMM authorities as they're verified.
]);
const BURN_OWNERS = new Set([
  "1nc1nerator11111111111111111111111111111111",
  SYSTEM_PROGRAM,
]);

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

  // Resolve the OWNERS of the top token accounts (always — used for both holder
  // classification and smart-money overlap). Best-effort: on failure we degrade.
  const addrs = (largest?.result?.value || []).map(v => v.address).filter(Boolean).slice(0, 20);
  let owners = [];
  let ownersReliable = false;
  if (rpc && addrs.length) {
    owners = await rpc("getMultipleAccounts", [addrs, { encoding: "jsonParsed" }])
      .then(r => (r?.result?.value || []).map(a => a?.data?.parsed?.info?.owner))
      .catch(() => []);
    ownersReliable = owners.length === addrs.length && owners.every(Boolean);
  }

  const holders = parseHolders(largest, owners);

  // Smart-money overlap — only trusted when owner resolution actually succeeded,
  // so a transient RPC failure can't masquerade as "smart money exited".
  let sm = { count: 0, labels: [] };
  let smartMoneyReliable = false;
  if (rpc && smSet.set.size && ownersReliable) {
    sm = matchSmartMoney(owners, smSet);
    smartMoneyReliable = true;
  }

  const raw = {
    mint: mintInfo, // null → authorities UNKNOWN (scoring says so, never "revoked")
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
    smartMoneyReliable,
    market: market && {
      priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd, volume24h: market.volume24h,
      mcap: market.mcap, dexId: market.dexId, symbol: market.symbol, name: market.name, icon: market.icon,
      websites: market.websites, socials: market.socials,
    },
    dataComplete: !!mintInfo, // false when authorities couldn't be read
    disclaimer: "Heuristic risk estimate from public on-chain data. Not financial advice. Always DYOR.",
  };
}

function bestMarket(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  // Rank by liquidity depth; pumpswap only breaks ties (it used to override, so a
  // $0 pumpswap pair could beat a $2M Raydium pair and mislabel a token as thin).
  const score = p => (p.liquidity?.usd || 0) + (p.dexId === "pumpswap" ? 1 : 0);
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
    websites: p.info?.websites?.map(w => w?.url).filter(Boolean) || [],
    socials: p.info?.socials?.map(s => s?.type || s?.platform).filter(Boolean) || [],
  };
}

function parseMintInfo(info) {
  const val = info?.result?.value;
  const parsed = val?.data?.parsed?.info;
  if (!parsed) return null;
  const decimals = parsed.decimals ?? 0;

  // Token-2022 honeypot levers live in `extensions` — read them.
  let transferFeeBps = null, transferHook = null, permanentDelegate = null, defaultFrozen = false;
  for (const e of (parsed.extensions || [])) {
    if (e.extension === "transferFeeConfig") {
      const fee = e.state?.newerTransferFee ?? e.state?.olderTransferFee ?? e.state;
      transferFeeBps = fee?.transferFeeBasisPoints ?? transferFeeBps;
    } else if (e.extension === "transferHook") {
      transferHook = e.state?.programId ?? null;
    } else if (e.extension === "permanentDelegate") {
      permanentDelegate = e.state?.delegate ?? null;
    } else if (e.extension === "defaultAccountState") {
      defaultFrozen = e.state?.accountState === "frozen";
    }
  }

  return {
    mintAuthority: parsed.mintAuthority ?? null,   // null = revoked (good)
    freezeAuthority: parsed.freezeAuthority ?? null,
    decimals,
    supply: Number(parsed.supply) / Math.pow(10, decimals),
    token2022: val?.data?.program === "spl-token-2022",
    transferFeeBps,
    transferHook,
    permanentDelegate,
    defaultFrozen,
  };
}

// Build holders keyed by OWNER (aggregating an owner split across accounts) and
// classify pool / burn by owner. `owners[i]` aligns with the i-th largest
// account. When owners are unavailable we key by account and treat all as
// holders — the safe (over-count) direction.
function parseHolders(largest, owners) {
  const vals = largest?.result?.value;
  if (!Array.isArray(vals) || !vals.length) return [];
  const byOwner = new Map();
  vals.slice(0, 20).forEach((v, i) => {
    const amount = Number(v.uiAmountString ?? v.uiAmount ?? 0) || 0;
    const owner = owners[i] || null;
    const key = owner || ("acct:" + (v.address || i));
    const kind = owner && BURN_OWNERS.has(owner) ? "burn"
      : owner && POOL_OWNERS.has(owner) ? "pool"
      : "holder";
    const cur = byOwner.get(key) || { amount: 0, kind, owner };
    cur.amount += amount;
    byOwner.set(key, cur);
  });
  return [...byOwner.values()];
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
