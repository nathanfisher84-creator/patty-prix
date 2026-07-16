// Rug or Moon — token scoring engine.
//
// Pure, deterministic scoring from public on-chain facts. No network here — the
// serverless /api/scan gathers the raw data (DexScreener + Solana RPC) and calls
// scoreToken(). Kept dependency-free and testable so the logic is verifiable.
//
// These are HEURISTICS, not a guarantee. A high score is not a green light and a
// low score is not proof of a scam — the UI shows this. Not financial advice.

// Addresses that are not real holders — the burn/incinerator and the system
// program. Excluded from "insider concentration".
export const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const pct = n => Math.round(n * 1000) / 10; // one decimal percent

// raw = {
//   mint:   { mintAuthority, freezeAuthority, decimals, supply }   // supply = ui number
//   holders:[{ amount, kind }]  // amount = ui number; kind: 'holder'|'pool'|'burn' (default holder)
//   market: { liquidityUsd, volume24h, priceUsd, mcap, ageMs, buys24h, sells24h, dexId } | null
//   smartMoney: [owner,...]     // optional: known smart-money owners
//   smartMoneyHolders: number   // optional: count of smart-money wallets holding
// }
export function scoreToken(raw = {}) {
  const flags = [];
  const add = (level, text) => flags.push({ level, text });
  const m = raw.mint || {};
  const market = raw.market || null;

  let points = 0, max = 0;
  const factor = (weight, earned, red, green) => {
    max += weight; points += earned;
    if (earned >= weight * 0.99 && green) add("green", green);
    else if (earned <= weight * 0.34 && red) add("red", red);
    else if (red && earned < weight * 0.99) add("yellow", red);
  };

  // 1) Mint authority — can the creator print unlimited new supply?
  if (m.mintAuthority == null) factor(28, 28, null, "Mint authority revoked — supply can't be inflated");
  else { max += 28; add("red", "Mint authority is ACTIVE — creator can mint unlimited tokens"); }

  // 2) Freeze authority — can the creator freeze your tokens (a honeypot lever)?
  if (m.freezeAuthority == null) factor(14, 14, null, "Freeze authority revoked — your tokens can't be frozen");
  else { max += 14; add("red", "Freeze authority is ACTIVE — creator can freeze your wallet"); }

  // 3) Holder concentration — how much do non-pool, non-burn wallets control?
  const conc = concentration(raw);
  if (conc != null) {
    const earned = clamp(24 * (1 - (conc - 0.1) / 0.5), 0, 24); // 10% → full, 60%+ → 0
    factor(24, earned,
      `Top holders control ${pct(conc)}% of supply`,
      conc <= 0.15 ? `Healthy distribution — top wallets hold only ${pct(conc)}%` : null);
  } else { max += 24; add("yellow", "Holder distribution unknown"); }

  // 4) Liquidity — thin pools are trivial to rug.
  const liq = market?.liquidityUsd ?? 0;
  if (!market) { max += 20; add("red", "No liquidity pool found — likely untradeable / dead"); }
  else {
    const earned = liq >= 50_000 ? 20 : liq >= 10_000 ? 12 : liq >= 2_000 ? 5 : 0;
    factor(20, earned, `Low liquidity (${usd(liq)}) — easy to rug or exit`,
      liq >= 50_000 ? `Deep liquidity (${usd(liq)})` : null);
  }

  // 5) Age — brand-new tokens are the highest-risk window.
  const ageMs = market?.ageMs;
  if (ageMs != null) {
    const days = ageMs / 86_400_000;
    const earned = days >= 30 ? 8 : days >= 7 ? 6 : days >= 1 ? 3 : 0;
    factor(8, earned, days < 1 ? "Brand new (<24h) — highest-risk window" : null,
      days >= 30 ? "Established (>30 days)" : null);
  } else max += 8;

  // 6) Wash-trading smell — volume wildly out of line with liquidity.
  if (market && liq > 0 && market.volume24h != null) {
    const ratio = market.volume24h / liq;
    const earned = ratio > 50 ? 0 : ratio > 20 ? 3 : 6;
    factor(6, earned, ratio > 20 ? `24h volume is ${Math.round(ratio)}× liquidity — possible wash trading` : null,
      ratio >= 1 && ratio <= 20 ? "Volume/liquidity looks organic" : null);
  } else max += 6;

  const safety = Math.round((points / max) * 100);
  const tier = safety >= 75 ? "clean" : safety >= 45 ? "caution" : "high-risk";

  return { safety, tier, flags: rank(flags), alpha: alphaScore(raw, market), concentration: conc };
}

function concentration(raw) {
  const holders = raw.holders;
  const supply = raw.mint?.supply;
  if (!Array.isArray(holders) || !holders.length || !supply) return null;
  const insiders = holders
    .filter(h => (h.kind ?? "holder") === "holder")
    .reduce((s, h) => s + (Number(h.amount) || 0), 0);
  return clamp(insiders / supply, 0, 1);
}

// Alpha: is smart money here, and is momentum real? 0–100, separate from safety.
function alphaScore(raw, market) {
  const signals = [];
  let score = 0;
  const smHolders = raw.smartMoneyHolders ?? (Array.isArray(raw.smartMoney) && Array.isArray(raw.holders)
    ? raw.holders.filter(h => raw.smartMoney.includes(h.owner)).length : 0);
  if (smHolders > 0) {
    score += Math.min(60, smHolders * 20);
    const who = raw.smartMoneyLabels?.length
      ? ` (${raw.smartMoneyLabels.slice(0, 2).join(", ")}${raw.smartMoneyLabels.length > 2 ? ", +" + (raw.smartMoneyLabels.length - 2) : ""})`
      : "";
    signals.push(`${smHolders} tracked smart-money wallet${smHolders > 1 ? "s" : ""} holding${who}`);
  }

  if (market && market.buys24h != null && market.sells24h != null) {
    const buys = market.buys24h, sells = market.sells24h || 0;
    if (buys > sells * 1.3) { score += 25; signals.push("Buy pressure — buyers outnumber sellers"); }
    else if (sells > buys * 1.3) { score -= 10; signals.push("Sell pressure — sellers outnumber buyers"); }
  }
  if (market && market.liquidityUsd >= 25_000 && market.volume24h >= market.liquidityUsd) {
    score += 15; signals.push("Active trading on solid liquidity");
  }
  return { score: clamp(Math.round(score), 0, 100), signals };
}

// Reds first, then yellows, then greens — worst news up top.
function rank(flags) {
  const order = { red: 0, yellow: 1, green: 2 };
  return [...flags].sort((a, b) => order[a.level] - order[b.level]);
}

function usd(n) {
  if (n == null) return "—";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + Math.round(n);
}

export const VERDICT = {
  clean: { emoji: "✅", label: "Looks clean", note: "No major red flags — still DYOR." },
  caution: { emoji: "⚠️", label: "Caution", note: "Mixed signals — understand the risks before aping." },
  "high-risk": { emoji: "🚩", label: "High risk", note: "Serious red flags — high chance of a rug." },
};
