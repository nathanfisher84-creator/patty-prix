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

// Classify holders by OWNER, never by "biggest account is the pool" (that hid a
// dev whale larger than the LP). A liquidity-pool vault is a token account whose
// authority is a PDA owned by an AMM PROGRAM — so we detect pools generally by
// resolving each holder's authority and checking which program owns it, rather
// than hardcoding per-pool addresses (there are millions). This covers every
// pool on every listed AMM below. A known fast-path authority set is kept for
// when the extra lookup fails. Anything we still can't identify is COUNTED
// (safe direction: over-warn, never false-clean) with a "verify" hint.
const AMM_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",  // Raydium CPMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpools
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",  // Orca Token Swap v2
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",   // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",  // Meteora Pools (DAMM)
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",   // PumpSwap AMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",   // Pump.fun bonding curve
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",   // Phoenix
]);
const POOL_OWNERS = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j", // Raydium AMM v4 authority (fast-path)
]);
const BURN_OWNERS = new Set([
  "1nc1nerator11111111111111111111111111111111",
  SYSTEM_PROGRAM,
]);

// Core, testable: gather → score. `fetchFn` and `smartMoney` injectable for tests.
export async function scanToken(mint, { heliusKey, fetchFn = fetch, smartMoney, flagged } = {}) {
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

  const [pairsRes, info, largest, lpReport, jupTok, goplusRes, meteoraRes] = await Promise.all([
    fetchFn("https://api.dexscreener.com/token-pairs/v1/solana/" + mint)
      .then(r => (r && r.ok === false ? [] : r.json())).catch(() => []),
    rpc ? rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]).catch(() => null) : null,
    rpc ? rpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]).catch(() => null) : null,
    // RugCheck (keyless public API) — the one thing we can't compute ourselves:
    // is the liquidity locked/burned so the dev can't pull it? Best-effort.
    fetchFn("https://api.rugcheck.xyz/v1/tokens/" + mint + "/report")
      .then(r => (r && r.ok === false ? null : r.json())).catch(() => null),
    // Jupiter Tokens (keyless) — is it on Jupiter's verified list? Legitimacy signal.
    fetchFn("https://tokens.jup.ag/token/" + mint)
      .then(r => (r && r.ok === false ? null : r.json())).catch(() => null),
    // GoPlus (keyless) — an independent second security opinion (cross-check).
    fetchFn("https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=" + mint)
      .then(r => (r && r.ok === false ? null : r.json())).catch(() => null),
    // Meteora DLMM API (keyless) — native pool data: real reserves, is_blacklisted
    // (Meteora's own scam flag), fee config, holder count. Powers the "cut supply
    // on the pump" detection with Meteora's actual quote reserve.
    fetchFn("https://dlmm.datapi.meteora.ag/pools?query=" + mint + "&page_size=50")
      .then(r => (r && r.ok === false ? null : r.json())).catch(() => null),
  ]);

  const market = bestMarket(pairsRes);
  const mintInfo = parseMintInfo(info);
  const meteora = parseMeteora(meteoraRes, mint);
  const lp = parseLpLock(lpReport);
  const jup = parseJupiter(jupTok);
  const goplus = parseGoPlus(goplusRes, mint);

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

  // Which program owns each holder's authority? An authority owned by an AMM
  // program is a pool vault (works across every AMM, no per-pool hardcoding).
  let ownerProgram = {}; // authority -> owning program id
  const distinctOwners = [...new Set(owners.filter(Boolean))];
  if (rpc && distinctOwners.length) {
    ownerProgram = await rpc("getMultipleAccounts", [distinctOwners, { encoding: "jsonParsed" }])
      .then(r => {
        const out = {};
        (r?.result?.value || []).forEach((a, i) => { out[distinctOwners[i]] = a?.owner || null; });
        return out;
      })
      .catch(() => ({}));
  }

  const holders = parseHolders(largest, owners, ownerProgram);

  // Smart-money overlap — only trusted when owner resolution actually succeeded,
  // so a transient RPC failure can't masquerade as "smart money exited".
  let sm = { count: 0, labels: [] };
  let smartMoneyReliable = false;
  if (rpc && smSet.set.size && ownersReliable) {
    sm = matchSmartMoney(owners, smSet);
    smartMoneyReliable = true;
  }

  // Flagged wallets — the INVERSE of smart money. Wallets you want to be warned
  // about (known insiders/ruggers/dev wallets): if one of them holds this token,
  // surface it loudly. Same owner-matching machinery as smart money.
  const fl = (flagged && flagged.set?.size && ownersReliable) ? matchSmartMoney(owners, flagged) : { count: 0, labels: [] };

  const raw = {
    mint: mintInfo, // null → authorities UNKNOWN (scoring says so, never "revoked")
    holders,
    market,
    smartMoneyHolders: sm.count,
    smartMoneyLabels: sm.labels,
    flaggedHolders: fl.count,
    flaggedLabels: fl.labels,
    lpLockedPct: lp.lpLockedPct, // null when unknown
    rugged: lp.rugged,
    jupVerified: jup.verified,
    goplusFlags: goplus?.flags || null,
    goplusTrusted: goplus?.trusted || false,
    meteora,
  };

  // Which independent scanners we could reach + what they said (for the UI's
  // "cross-checked" trust line). External signals can only ADD caution.
  const sources = {
    rugcheck: lpReport ? "ok" : "na",
    goplus: goplus ? (goplus.flags.length ? "flag" : "ok") : "na",
    jupiter: jup.verified ? "verified" : (jupTok ? "listed" : "na"),
    meteora: meteora ? (meteora.blacklisted ? "flag" : "ok") : "na",
  };

  const result = scoreToken(raw);

  // Top individual holders (non-pool, non-burn), by % of supply — so a buyer can
  // see the actual bag distribution, not just an aggregate number.
  const supply = mintInfo?.supply || 0;
  const topHolders = supply > 0
    ? holders.filter(h => (h.kind ?? "holder") === "holder")
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
        .map(h => ({ pct: Math.round((h.amount / supply) * 1000) / 10, owner: h.owner || null }))
    : [];

  return {
    token: mint,
    ...result,
    smartMoneyHolders: sm.count,
    smartMoneyReliable,
    flaggedHolders: fl.count,
    flaggedLabels: fl.labels,
    lpLockedPct: lp.lpLockedPct,
    jupVerified: jup.verified,
    holders: meteora?.holders ?? goplus?.holders ?? null, // best available holder count
    topHolders,
    // Owners that are NOT real holders (LP vaults, burn) — so callers doing
    // deeper holder analysis can exclude them instead of re-deriving the rules.
    excludedOwners: [...new Set(holders.filter(h => h.kind !== "holder" && h.owner).map(h => h.owner))],
    sources,
    meteora: meteora && { pools: meteora.pools, blacklisted: meteora.blacklisted, maxFeePct: meteora.maxFeePct, holders: meteora.holders, launchpad: meteora.launchpad },
    market: market && {
      priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd, volume24h: market.volume24h,
      mcap: market.mcap, dexId: market.dexId, symbol: market.symbol, name: market.name, icon: market.icon,
      websites: market.websites, socials: market.socials,
      liqQuote: market.liqQuote, priceChange1h: market.priceChange1h, priceChange24h: market.priceChange24h,
      // Prefer Meteora's native quote reserve for the "cut supply on pump" signal.
      meteoraQuote: meteora?.quoteReserve ?? null,
    },
    dataComplete: !!mintInfo, // false when authorities couldn't be read
    disclaimer: "Heuristic risk estimate from public on-chain data. Not financial advice. Always DYOR.",
  };
}

// Best-effort deployer lookup: the wallet that created the mint (fee payer of the
// mint's OLDEST transaction). For fresh memecoins — the target here — the
// creation tx is almost always within the first page of signatures, so this is
// reliable; for very old tokens it may be approximate (flagged). Returns null on
// any failure — never guesses. The bot cross-references `creator` against
// topHolders to warn if the deployer still holds a big bag (a top dump risk).
export async function findDeployer(mint, { heliusKey, fetchFn = fetch } = {}) {
  if (!heliusKey || !BASE58.test(mint)) return null;
  const rpc = (method, params) => fetchFn("https://mainnet.helius-rpc.com/?api-key=" + heliusKey, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then(r => r.json());
  try {
    const sigs = await rpc("getSignaturesForAddress", [mint, { limit: 1000 }]).then(r => r?.result || []);
    if (!sigs.length) return null;
    const oldest = sigs[sigs.length - 1];
    const tx = await rpc("getTransaction", [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]).then(r => r?.result);
    const keys = tx?.transaction?.message?.accountKeys || [];
    const first = keys[0];
    const creator = typeof first === "string" ? first : first?.pubkey;
    if (!creator) return null;
    return { creator, approx: sigs.length >= 1000, createdAt: oldest.blockTime || null };
  } catch { return null; }
}

function bestMarket(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  // Rank by liquidity depth; pumpswap only breaks ties (it used to override, so a
  // $0 pumpswap pair could beat a $2M Raydium pair and mislabel a token as thin).
  const score = p => (p.liquidity?.usd || 0) + (p.dexId === "pumpswap" ? 1 : 0);
  const p = pairs.reduce((a, b) => (score(b) > score(a) ? b : a));
  return {
    liquidityUsd: p.liquidity?.usd || 0,
    liqQuote: p.liquidity?.quote ?? null, // SOL/stable side of the pool — real depth, immune to price moves
    liqBase: p.liquidity?.base ?? null,   // token side of the pool
    volume24h: p.volume?.h24 ?? 0,
    priceUsd: parseFloat(p.priceUsd) || null,
    priceChange1h: p.priceChange?.h1 ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
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

// Pull LP-lock info out of a RugCheck report. We take the BEST-locked market
// (max lpLockedPct) as the headline — a token is safe from an LP rug if any of
// its real pools is locked/burned. `lpLockedPct` is a 0–100 percentage in
// RugCheck's schema. Degrades to {lpLockedPct:null} on any missing/odd data, so
// an unavailable RugCheck response never invents a signal.
// NOTE: coded to RugCheck's documented schema; sanity-check against one real
// token after deploy (this sandbox has no live network to verify against).
function parseLpLock(report) {
  if (!report || typeof report !== "object") return { lpLockedPct: null, rugged: false };
  let pct = null;
  for (const mk of (Array.isArray(report.markets) ? report.markets : [])) {
    const p = mk?.lp?.lpLockedPct;
    if (typeof p === "number" && isFinite(p)) pct = pct == null ? p : Math.max(pct, p);
  }
  return { lpLockedPct: pct, rugged: report.rugged === true };
}

// Jupiter token entry → is it on the verified/strict list? Absence is NOT a
// negative (many legit new tokens aren't listed yet), only presence is a plus.
function parseJupiter(t) {
  if (!t || typeof t !== "object") return { verified: null };
  const tags = Array.isArray(t.tags) ? t.tags : [];
  const verified = t.isVerified === true || t.verified === true || tags.some(x => /^(verified|strict)$/i.test(String(x)));
  return { verified: !!verified };
}

// GoPlus Solana token-security → a compact list of danger signals it reports, as
// an independent second opinion. Strictly additive (can only add caution). Coded
// defensively to GoPlus's documented shape; sanity-check against a real token
// after deploy. Returns null when nothing parseable came back.
function parseGoPlus(res, mint) {
  const map = res?.result;
  const r = (map && (map[mint] || Object.values(map)[0])) || null;
  if (!r || typeof r !== "object") return null;
  const on = v => { const s = v && typeof v === "object" ? v.status : v; return s === "1" || s === 1 || s === true; };
  const flags = [];
  if (on(r.mintable)) flags.push("mint authority active");
  if (on(r.freezable)) flags.push("freeze authority active");
  if (on(r.non_transferable)) flags.push("non-transferable (can't sell)");
  if (Array.isArray(r.transfer_hook) ? r.transfer_hook.length : on(r.transfer_hook)) flags.push("transfer hook");
  if (on(r.closable)) flags.push("mint can be closed");
  const holders = Number(r.holder_count);
  return { flags, trusted: on(r.trusted_token), holders: isFinite(holders) && holders > 0 ? holders : null };
}

// Summarize a token's Meteora DLMM pools (schema per docs.meteora.ag). Only pools
// where our mint is one side count. The QUOTE reserve (the other side's amount,
// summed) is the precise "cut supply on the pump" signal. Also surfaces Meteora's
// own is_blacklisted flag, the pool fee ceiling, and holder count. Degrades to
// null if unavailable — never invents a signal. Coded to the documented schema;
// sanity-check against a real token after deploy (no live access in the sandbox).
function parseMeteora(res, mint) {
  const data = Array.isArray(res?.data) ? res.data : null;
  if (!data) return null;
  const pools = data.filter(p => p?.token_x?.address === mint || p?.token_y?.address === mint);
  if (!pools.length) return { pools: 0, blacklisted: false, quoteReserve: null, tvl: 0, maxFeePct: null, holders: null };

  let quoteReserve = 0, tvl = 0, maxFeePct = 0, blacklisted = false, holders = null, isVerified = null, launchpad = null;
  for (const p of pools) {
    const mintIsX = p.token_x?.address === mint;
    const quoteAmt = mintIsX ? p.token_y_amount : p.token_x_amount; // the SOL/stable side
    if (typeof quoteAmt === "number" && isFinite(quoteAmt)) quoteReserve += quoteAmt;
    if (typeof p.tvl === "number") tvl += p.tvl;
    const fee = p.pool_config?.max_fee_pct;
    if (typeof fee === "number" && fee > maxFeePct) maxFeePct = fee;
    if (p.is_blacklisted === true) blacklisted = true;
    const tk = mintIsX ? p.token_x : p.token_y;
    if (tk) { holders = holders == null ? tk.holders : Math.max(holders, tk.holders); isVerified = isVerified || tk.is_verified; }
    if (!launchpad && p.launchpad) launchpad = p.launchpad;
  }
  return { pools: pools.length, blacklisted, quoteReserve: quoteReserve || null, tvl, maxFeePct: maxFeePct || null, holders, isVerified, launchpad };
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
function parseHolders(largest, owners, ownerProgram = {}) {
  const vals = largest?.result?.value;
  if (!Array.isArray(vals) || !vals.length) return [];
  const byOwner = new Map();
  vals.slice(0, 20).forEach((v, i) => {
    const amount = Number(v.uiAmountString ?? v.uiAmount ?? 0) || 0;
    const owner = owners[i] || null;
    const key = owner || ("acct:" + (v.address || i));
    const kind = classifyOwner(owner, ownerProgram[owner]);
    const cur = byOwner.get(key) || { amount: 0, kind, owner };
    cur.amount += amount;
    byOwner.set(key, cur);
  });
  return [...byOwner.values()];
}

function classifyOwner(owner, program) {
  if (!owner) return "holder";
  if (BURN_OWNERS.has(owner)) return "burn";
  if (POOL_OWNERS.has(owner)) return "pool";              // fast-path
  if (program && AMM_PROGRAMS.has(program)) return "pool"; // general: authority is an AMM PDA
  return "holder";
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
