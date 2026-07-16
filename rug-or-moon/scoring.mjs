// Rug or Moon — token scoring engine.
//
// Pure, deterministic scoring from public on-chain facts. No network here — the
// serverless /api/scan gathers the raw data (DexScreener + Solana RPC) and calls
// scoreToken(). Kept dependency-free and testable so the logic is verifiable.
//
// These are HEURISTICS, not a guarantee. A high score is not a green light and a
// low score is not proof of a scam — the UI shows this. Not financial advice.
//
// Design rule after the trust audit: the engine must NEVER present a dangerous
// token as safe. When a fact is unknown we say "unknown" (never "revoked"), and
// hard danger signals (active authorities, honeypot vectors) CAP the tier so a
// high sub-score can't mint a "clean" verdict.

// Addresses that are not real holders — the burn/incinerator and the system
// program. Excluded from "insider concentration".
export const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const pct = n => Math.round(n * 1000) / 10; // one decimal percent
const RANK = { "high-risk": 0, caution: 1, clean: 2 };
const TIERS = ["high-risk", "caution", "clean"];

// raw = {
//   mint:   { mintAuthority, freezeAuthority, decimals, supply,          // supply = ui number
//             token2022, transferFeeBps, transferHook, permanentDelegate, defaultFrozen }
//           | null  → authorities UNKNOWN (no RPC key / RPC failure)
//   holders:[{ amount, kind, owner }]  // kind: 'holder'|'pool'|'burn' (default holder)
//   market: { liquidityUsd, volume24h, priceUsd, mcap, ageMs, buys24h, sells24h, dexId } | null
//   smartMoneyHolders: number   // count of tracked smart-money wallets holding
// }
export function scoreToken(raw = {}) {
  const flags = [];
  const add = (level, id, text) => flags.push({ level, id, text });
  const m = raw.mint;
  const known = !!(m && "mintAuthority" in m); // a parsed mint always carries this key
  const market = raw.market || null;

  let points = 0, max = 0;
  // Tier cap: hard danger signals lower the best-allowed tier regardless of score.
  let capRank = RANK.clean;
  const cap = t => { capRank = Math.min(capRank, RANK[t]); };

  const factor = (weight, earned, id, red, green) => {
    max += weight; points += earned;
    if (earned >= weight * 0.99 && green) add("green", id, green);
    else if (earned <= weight * 0.34 && red) add("red", id, red);
    else if (red && earned < weight * 0.99) add("yellow", id, red);
  };

  // Unknown facts are NEUTRAL (excluded from the score), not zero-scored — a
  // transient RPC miss shouldn't fake a rug any more than it should fake safety.
  // They cap the tier at "caution" so we never certify what we couldn't check.

  // 1) Mint authority — can the creator print unlimited new supply?
  if (!known) { add("yellow", "mint-authority", "Mint authority unknown — couldn't read it on-chain; treat with caution"); cap("caution"); }
  else if (m.mintAuthority == null) { max += 28; points += 28; add("green", "mint-authority", "Mint authority revoked — supply can't be inflated"); }
  else { max += 28; add("red", "mint-authority", "Mint authority is ACTIVE — creator can mint unlimited tokens"); cap("caution"); }

  // 2) Freeze authority — can the creator freeze your tokens (a honeypot lever)?
  if (!known) { add("yellow", "freeze-authority", "Freeze authority unknown — couldn't read it on-chain"); cap("caution"); }
  else if (m.freezeAuthority == null) { max += 14; points += 14; add("green", "freeze-authority", "Freeze authority revoked — your tokens can't be frozen"); }
  else { max += 14; add("red", "freeze-authority", "Freeze authority is ACTIVE — creator can freeze your wallet"); cap("caution"); }

  // Both authorities live = infinite-mint + freeze honeypot: force high-risk.
  if (known && m.mintAuthority != null && m.freezeAuthority != null) cap("high-risk");

  // 2b) Token-2022 extension traps — the real honeypot levers on new tokens.
  if (known) {
    if (m.permanentDelegate) { add("red", "t22-delegate", "Permanent delegate set — a wallet can seize or burn your tokens at any time"); cap("high-risk"); }
    if (m.defaultFrozen) { add("red", "t22-frozen", "Accounts are frozen by default — likely a honeypot (you may be unable to sell)"); cap("high-risk"); }
    if (m.transferHook && m.transferHook !== SYSTEM_PROGRAM) { add("red", "t22-hook", "Transfer hook active — the creator's program runs on every trade and can block sells"); cap("caution"); }
    const feeBps = m.transferFeeBps || 0;
    if (feeBps >= 5000) { add("red", "t22-fee", `Transfer tax ${(feeBps / 100).toFixed(1)}% — almost certainly a honeypot`); cap("high-risk"); }
    else if (feeBps >= 1000) { add("red", "t22-fee", `High transfer tax ${(feeBps / 100).toFixed(1)}% on every trade`); cap("caution"); }
    else if (feeBps > 0) { add("yellow", "t22-fee", `Transfer tax ${(feeBps / 100).toFixed(1)}% on every trade`); }
  }

  // 2c) Liquidity lock (from RugCheck) — can the dev pull the liquidity and rug?
  // The single biggest rug lever, and the one thing we can't compute ourselves.
  if (typeof raw.lpLockedPct === "number") {
    const p = raw.lpLockedPct;
    if (p >= 90) add("green", "lp-lock", `Liquidity ${Math.round(p)}% locked/burned — dev can't pull it`);
    else if (p >= 50) add("yellow", "lp-lock", `Only ${Math.round(p)}% of liquidity is locked — partial rug risk`);
    else { add("red", "lp-lock", `Liquidity is just ${Math.round(p)}% locked — dev can pull the rest and rug`); cap("caution"); }
  }
  if (raw.rugged) { add("red", "rugged", "RugCheck has flagged this token as already rugged"); cap("high-risk"); }

  // 2d) Independent cross-checks — Jupiter verified list + GoPlus second opinion.
  // These can only ADD caution (or reassurance), never certify safety.
  if (raw.jupVerified) add("green", "jup-verified", "On Jupiter's verified token list");
  if (Array.isArray(raw.goplusFlags) && raw.goplusFlags.length) {
    add("yellow", "goplus", `Second opinion (GoPlus) also flags: ${raw.goplusFlags.join(", ")}`);
    cap("caution");
  } else if (raw.goplusTrusted) {
    add("green", "goplus", "GoPlus lists this as a trusted token");
  }

  // 3) Holder concentration — how much do non-pool, non-burn OWNERS control?
  const conc = concentration(raw);
  if (conc != null) {
    max += 24; points += clamp(24 * (1 - (conc - 0.1) / 0.5), 0, 24); // 10%→full, 60%+→0
    if (conc <= 0.15) add("green", "concentration", `Healthy distribution — top holders hold only ${pct(conc)}%`);
    else if (conc >= 0.5) add("red", "concentration", `Top holders control ${pct(conc)}% of supply`);
    else add("yellow", "concentration", `Top holders control ${pct(conc)}% of supply`);
    // Extreme concentration is itself a rug lever — cap the verdict so a token
    // can't earn its way to "clean" while a few wallets can dump on everyone.
    if (conc >= 0.7) cap("high-risk");
    else if (conc >= 0.5) cap("caution");
    // Pools/burns are already excluded by owner. If a large share still sits in
    // one un-clearable wallet on a liquid token, it's worth an eyeball — it's
    // usually a real whale, occasionally an unlisted LP or a CEX hot wallet.
    if (conc >= 0.3 && (market?.liquidityUsd || 0) >= 10_000)
      add("yellow", "pool-unverified", "A large share sits in one wallet — verify on Solscan it's not an unlisted pool or exchange");
  } else { add("yellow", "concentration", "Holder distribution unknown — couldn't read it on-chain"); cap("caution"); }

  // 4) Liquidity — thin pools are trivial to rug.
  const liq = market?.liquidityUsd ?? 0;
  if (!market) { max += 20; add("red", "liquidity", "No liquidity pool found — likely untradeable / dead"); }
  else {
    const earned = liq >= 50_000 ? 20 : liq >= 10_000 ? 12 : liq >= 2_000 ? 5 : 0;
    factor(20, earned, "liquidity", `Low liquidity (${usd(liq)}) — easy to rug or exit`,
      liq >= 50_000 ? `Deep liquidity (${usd(liq)})` : null);
  }

  // 5) Age — brand-new tokens are the highest-risk window.
  const ageMs = market?.ageMs;
  if (ageMs != null && ageMs >= 0) {
    const days = ageMs / 86_400_000;
    const earned = days >= 30 ? 8 : days >= 7 ? 6 : days >= 1 ? 3 : 0;
    factor(8, earned, "age", days < 1 ? "Brand new (<24h) — highest-risk window" : null,
      days >= 30 ? "Established (>30 days)" : null);
  } else max += 8; // unknown / bad timestamp → neither reward nor punish

  // 6) Wash-trading smell — volume wildly out of line with liquidity.
  if (market && liq > 0 && market.volume24h != null) {
    const ratio = market.volume24h / liq;
    const earned = ratio > 50 ? 0 : ratio > 20 ? 3 : 6;
    factor(6, earned, "wash", ratio > 20 ? `24h volume is ${Math.round(ratio)}× liquidity — possible wash trading` : null,
      ratio >= 1 && ratio <= 20 ? "Volume/liquidity looks organic" : null);
  } else max += 6;

  // 7) Honeypot smell from trading shape — lots of buys, almost no sells.
  if (market && market.buys24h != null && market.sells24h != null) {
    const b = market.buys24h, s = market.sells24h;
    if (b >= 30 && s <= b * 0.03) { add("red", "honeypot-nosell", "Almost no sell transactions despite active buying — possible honeypot (can't sell)"); cap("high-risk"); }
  }

  let safety = Math.round((points / max) * 100);
  const scoreRank = safety >= 75 ? RANK.clean : safety >= 45 ? RANK.caution : RANK["high-risk"];
  const finalRank = Math.min(scoreRank, capRank);
  const tier = TIERS[finalRank];
  // Keep the number coherent with a capped verdict (no "80 / high risk").
  if (finalRank === RANK["high-risk"]) safety = Math.min(safety, 40);
  else if (finalRank === RANK.caution) safety = Math.min(safety, 70);

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
    // Never read a honeypot's fake buys as bullish momentum.
    const honeypotSmell = buys >= 30 && sells <= buys * 0.03;
    if (honeypotSmell) { /* no momentum credit — the safety flags already warn */ }
    else if (buys > sells * 1.3) { score += 25; signals.push("Buy pressure — buyers outnumber sellers"); }
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
