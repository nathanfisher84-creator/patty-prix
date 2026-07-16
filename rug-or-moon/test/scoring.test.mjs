// Offline tests for the scoring engine. Run: node test/scoring.test.mjs
import { scoreToken, VERDICT } from "../scoring.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};
const hasFlag = (r, level, re) => r.flags.some(f => f.level === level && re.test(f.text));

console.log("\n1. A clean token scores high");
const clean = scoreToken({
  mint: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: 1_000_000_000 },
  holders: [
    { amount: 400_000_000, kind: "pool" },   // LP — excluded
    { amount: 30_000_000, kind: "holder" }, { amount: 20_000_000, kind: "holder" },
    { amount: 10_000_000, kind: "holder" },
  ],
  market: { liquidityUsd: 250_000, volume24h: 300_000, ageMs: 60 * 86_400_000, buys24h: 900, sells24h: 500 },
});
check("high safety score", clean.safety >= 75, `got ${clean.safety}`);
check("tier is clean", clean.tier === "clean");
check("green: mint revoked", hasFlag(clean, "green", /Mint authority revoked/));
check("green: freeze revoked", hasFlag(clean, "green", /Freeze authority revoked/));
check("concentration excludes the LP pool", clean.concentration <= 0.07, `conc ${clean.concentration}`);

console.log("\n2. A rug token scores low with red flags");
const rug = scoreToken({
  mint: { mintAuthority: "Creator11111111111111111111111111111111111", freezeAuthority: "Creator11111111111111111111111111111111111", decimals: 6, supply: 1_000_000_000 },
  holders: [{ amount: 700_000_000, kind: "holder" }, { amount: 100_000_000, kind: "holder" }],
  market: { liquidityUsd: 1_500, volume24h: 400_000, ageMs: 3 * 3_600_000, buys24h: 50, sells24h: 400 },
});
check("low safety score", rug.safety < 45, `got ${rug.safety}`);
check("tier is high-risk", rug.tier === "high-risk");
check("red: mint authority active", hasFlag(rug, "red", /Mint authority is ACTIVE/));
check("red: freeze authority active", hasFlag(rug, "red", /Freeze authority is ACTIVE/));
check("red: high concentration", hasFlag(rug, "red", /Top holders control/));
check("red: low liquidity", hasFlag(rug, "red", /Low liquidity/));
check("red flags sorted to the top", rug.flags[0].level === "red");

console.log("\n3. No market / dead token");
const dead = scoreToken({
  mint: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: 1_000_000 },
  holders: [{ amount: 100, kind: "holder" }],
  market: null,
});
check("flags no liquidity pool", hasFlag(dead, "red", /No liquidity pool found/));
check("still gives a numeric score", typeof dead.safety === "number");

console.log("\n4. Wash-trading smell");
const wash = scoreToken({
  mint: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: 1e9 },
  holders: [{ amount: 5e7, kind: "holder" }],
  market: { liquidityUsd: 10_000, volume24h: 900_000, ageMs: 10 * 86_400_000, buys24h: 100, sells24h: 100 },
});
check("flags volume ≫ liquidity", hasFlag(wash, "red", /wash trading/i) || hasFlag(wash, "yellow", /wash trading/i));

console.log("\n5. Alpha — smart money + momentum");
const alpha = scoreToken({
  mint: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: 1e9 },
  holders: [{ amount: 1e7, kind: "holder", owner: "whaleA" }, { amount: 5e6, kind: "holder", owner: "whaleB" }],
  smartMoney: ["whaleA", "whaleB"],
  market: { liquidityUsd: 80_000, volume24h: 200_000, ageMs: 20 * 86_400_000, buys24h: 1000, sells24h: 400 },
});
check("alpha detects smart money holders", /smart-money/.test(alpha.alpha.signals.join(" ")));
check("alpha score is elevated", alpha.alpha.score >= 60, `got ${alpha.alpha.score}`);
check("alpha notes buy pressure", /Buy pressure/.test(alpha.alpha.signals.join(" ")));
const noAlpha = scoreToken({ mint: { mintAuthority: null, freezeAuthority: null, supply: 1e9, decimals: 6 }, holders: [], market: { liquidityUsd: 5000, volume24h: 100, ageMs: 1e9, buys24h: 1, sells24h: 9 } });
check("alpha low when no smart money + sell pressure", noAlpha.alpha.score <= 10);

console.log("\n6. Verdicts exist for every tier");
check("verdict copy present", VERDICT[clean.tier].label && VERDICT[rug.tier].emoji && VERDICT[dead.tier].note);

console.log("\n7. Robust to missing/garbage input");
check("empty input doesn't throw", typeof scoreToken().safety === "number");
check("partial input doesn't throw", typeof scoreToken({ mint: {} }).safety === "number");

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
