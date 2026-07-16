// Tests the API gather+score layer with mocked DexScreener + Helius RPC.
// Run: node test/scan.test.mjs
import { scanToken } from "../api/scan.mjs";
import { parseSmartMoney } from "../smart-money.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

// A mocked backend: DexScreener pairs + Helius getAccountInfo / getTokenLargestAccounts
// / getMultipleAccounts (owner resolution). `owners` maps token-account → owner.
const backend = ({ liq = 250_000, mintAuth = null, freezeAuth = null, holders, owners } = {}) => async (url, opts) => {
  const j = o => ({ ok: true, json: async () => o });
  if (url.includes("dexscreener.com")) {
    return j([{
      dexId: "raydium", priceUsd: "0.0000021", marketCap: 2_100_000,
      pairCreatedAt: Date.now() - 40 * 86_400_000,
      liquidity: { usd: liq }, volume: { h24: 300_000 }, txns: { h24: { buys: 800, sells: 500 } },
      baseToken: { symbol: "BONK", name: "Bonk" }, info: { imageUrl: "http://img" },
    }]);
  }
  const body = JSON.parse(opts.body);
  if (body.method === "getAccountInfo")
    return j({ result: { value: { data: { parsed: { info: {
      mintAuthority: mintAuth, freezeAuthority: freezeAuth, decimals: 6, supply: "1000000000000000",
    } } } } } }); // supply raw = 1e15 / 1e6 = 1e9 ui
  if (body.method === "getTokenLargestAccounts")
    return j({ result: { value: holders ?? [
      { address: "acct-pool", uiAmount: 400_000_000 },
      { address: "acct-1", uiAmount: 30_000_000 },
      { address: "acct-2", uiAmount: 20_000_000 },
    ] } });
  if (body.method === "getMultipleAccounts") {
    const addrs = body.params[0];
    return j({ result: { value: addrs.map(a => ({ data: { parsed: { info: { owner: (owners || {})[a] || ("owner-" + a) } } } })) } });
  }
  return j({});
};

console.log("\n1. Clean token — full scan");
const clean = await scanToken(MINT, { heliusKey: "k", fetchFn: backend() });
check("returns the scored result", typeof clean.safety === "number" && clean.tier);
check("clean tier", clean.tier === "clean", `tier ${clean.tier} safety ${clean.safety}`);
check("market surfaced (symbol/liquidity)", clean.market.symbol === "BONK" && clean.market.liquidityUsd === 250_000);
check("dataComplete true with Helius key", clean.dataComplete === true);
check("largest holder tagged as pool (liquid) → low concentration", clean.concentration <= 0.06, `conc ${clean.concentration}`);

console.log("\n2. Rug token — active authorities + low liquidity");
const rug = await scanToken(MINT, {
  heliusKey: "k",
  fetchFn: backend({ liq: 1_500, mintAuth: "Dev11111111111111111111111111111111111111", freezeAuth: "Dev11111111111111111111111111111111111111",
    holders: [{ uiAmount: 800_000_000 }, { uiAmount: 100_000_000 }] }),
});
check("high-risk tier", rug.tier === "high-risk", `tier ${rug.tier} safety ${rug.safety}`);
check("mint authority red flag", rug.flags.some(f => f.level === "red" && /Mint authority is ACTIVE/.test(f.text)));
check("low-liq token does NOT hide the top holder (counted)", rug.concentration >= 0.8, `conc ${rug.concentration}`);

console.log("\n3. No Helius key — degrades gracefully");
const noKey = await scanToken(MINT, { fetchFn: backend() });
check("still returns market-based result", typeof noKey.safety === "number");
check("dataComplete false (authorities unknown)", noKey.dataComplete === false);
check("flags distribution/authority as unknown, not crash", Array.isArray(noKey.flags));

console.log("\n4. Input validation");
check("rejects a bad address", (await scanToken("not-a-mint", {})).error != null);

console.log("\n5. Disclaimer always present");
check("carries the not-financial-advice disclaimer", /Not financial advice/.test(clean.disclaimer));

console.log("\n6. Smart-money alpha — resolves holder owners + flags overlap");
const sm = parseSmartMoney([{ wallet: "owner-acct-1", label: "Cupsey" }, { wallet: "owner-acct-2", label: "Whale2" }]);
const withSM = await scanToken(MINT, { heliusKey: "k", fetchFn: backend(), smartMoney: sm });
check("alpha counts the smart-money holders", /2 tracked smart-money wallets holding/.test(withSM.alpha.signals.join(" ")), withSM.alpha.signals.join(" | "));
check("names the wallets from labels", /Cupsey/.test(withSM.alpha.signals.join(" ")));
check("alpha score elevated by smart money", withSM.alpha.score >= 40, `got ${withSM.alpha.score}`);
const noSM = await scanToken(MINT, { heliusKey: "k", fetchFn: backend(), smartMoney: parseSmartMoney([]) });
check("no smart-money list → no smart-money signal", !/smart-money wallet/.test(noSM.alpha.signals.join(" ")));

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
