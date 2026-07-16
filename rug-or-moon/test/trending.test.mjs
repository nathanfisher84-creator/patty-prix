// Tests the trending gather+scan engine with mocked Birdeye/DexScreener + Helius.
// Run: node test/trending.test.mjs
import { scanTrending } from "../api/trending.mjs";
import { parseSmartMoney } from "../smart-money.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

const M1 = "So11111111111111111111111111111111111111112";
const M2 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const M3 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Mocked backend: trending source (birdeye/dexscreener) + per-token scan calls.
// `profiles` maps mint → { liq, mintAuth, holders } to make some tokens clean
// and some rugs.
const backend = ({ useBirdeye = false, geckoEmpty = false, profiles = {} } = {}) => async (url, opts) => {
  const j = o => ({ ok: true, json: async () => o });

  // External per-token cross-check calls (scanToken hits these) — neutral stubs.
  if (url.includes("rugcheck.xyz")) return j({ rugged: false, markets: [] });
  if (url.includes("tokens.jup.ag")) return j({ tags: [] });
  if (url.includes("gopluslabs.io")) return j({ result: {} });

  if (url.includes("token_trending")) {
    return j({ data: { tokens: [
      { address: M1, rank: 1 }, { address: M2, rank: 2 }, { address: M3, rank: 3 },
    ] } });
  }
  if (url.includes("trending_pools")) {
    return j({ data: geckoEmpty ? [] : [
      { relationships: { base_token: { data: { id: "solana_" + M1 } } } },
      { relationships: { base_token: { data: { id: "solana_" + M2 } } } },
      { relationships: { base_token: { data: { id: "solana_" + M3 } } } },
    ] });
  }
  if (url.includes("token-boosts")) {
    return j([
      { chainId: "solana", tokenAddress: M1 },
      { chainId: "ethereum", tokenAddress: "0xdeadbeef" }, // filtered out
      { chainId: "solana", tokenAddress: M2 },
      { chainId: "solana", tokenAddress: M2 }, // dupe, deduped
      { chainId: "solana", tokenAddress: M3 },
    ]);
  }
  // Per-token DexScreener market data — keyed by which mint is in the URL.
  if (url.includes("dexscreener.com/token-pairs")) {
    const mint = url.split("/").pop();
    const p = profiles[mint] || {};
    return j([{
      dexId: "raydium", priceUsd: "0.001", marketCap: 1_000_000,
      pairCreatedAt: Date.now() - 40 * 86_400_000,
      liquidity: { usd: p.liq ?? 200_000 }, volume: { h24: 150_000 },
      txns: { h24: { buys: 700, sells: 400 } },
      baseToken: { symbol: mint.slice(0, 4), name: mint.slice(0, 4) },
    }]);
  }
  const body = JSON.parse(opts.body);
  // Figure out which mint this RPC call is about (getAccountInfo carries it).
  const mint = body.params?.[0];
  const p = (typeof mint === "string" && profiles[mint]) || {};
  if (body.method === "getAccountInfo")
    return j({ result: { value: { data: { parsed: { info: {
      mintAuthority: p.mintAuth ?? null, freezeAuthority: null, decimals: 6, supply: "1000000000000000",
    } } } } } });
  if (body.method === "getTokenLargestAccounts")
    return j({ result: { value: p.holders ?? [
      { address: "pool", uiAmount: 400_000_000 }, { address: "h1", uiAmount: 10_000_000 },
    ] } });
  if (body.method === "getMultipleAccounts") {
    const addrs = body.params[0];
    return j({ result: { value: addrs.map(a => ({ data: { parsed: { info: { owner: "owner-" + a } } } })) } });
  }
  return j({});
};

console.log("\n1. Birdeye trending — scans each token");
const be = await scanTrending({ heliusKey: "k", birdeyeKey: "bk", fetchFn: backend({ useBirdeye: true }), smartMoney: parseSmartMoney([]) });
check("source is birdeye", be.source === "birdeye", `source ${be.source}`);
check("returns a scored token per trending mint", be.tokens.length === 3, `got ${be.tokens.length}`);
check("each token carries a safety score", be.tokens.every(t => typeof t.safety === "number"));
check("each token carries a trending rank", be.tokens.every(t => typeof t.trendingRank === "number"));

console.log("\n2. GeckoTerminal organic trending (no Birdeye key)");
const gt = await scanTrending({ heliusKey: "k", fetchFn: backend(), smartMoney: parseSmartMoney([]) });
check("source is geckoterminal (not paid boosts)", gt.source === "geckoterminal", `source ${gt.source}`);
check("parses base-token mints (3)", gt.tokens.length === 3, `got ${gt.tokens.length}`);

console.log("\n2b. DexScreener boosts as last resort (Gecko empty)");
const ds = await scanTrending({ heliusKey: "k", fetchFn: backend({ geckoEmpty: true }), smartMoney: parseSmartMoney([]) });
check("falls back to dexscreener", ds.source === "dexscreener", `source ${ds.source}`);
check("dedupes + filters to Solana (3 unique mints)", ds.tokens.length === 3, `got ${ds.tokens.length}`);

console.log("\n3. Board sort — gems above rugs");
const sorted = await scanTrending({
  heliusKey: "k", birdeyeKey: "bk", smartMoney: parseSmartMoney([]),
  fetchFn: backend({ useBirdeye: true, profiles: {
    [M2]: { liq: 1_000, mintAuth: "Dev1111111111111111111111111111111111111111",
            holders: [{ address: "x", uiAmount: 900_000_000 }] }, // a rug
  } }),
});
check("the rug is not ranked first", sorted.tokens[0].token !== M2, `first ${sorted.tokens[0].token}`);
check("the rug sinks to the bottom", sorted.tokens[sorted.tokens.length - 1].token === M2);
check("rug still visible on the board (not dropped)", sorted.tokens.some(t => t.token === M2));

console.log("\n4. Empty / limit handling");
const none = await scanTrending({ heliusKey: "k", fetchFn: async () => ({ ok: true, json: async () => [] }) });
check("no trending data → empty board, no crash", none.tokens.length === 0);
const limited = await scanTrending({ limit: 2, heliusKey: "k", birdeyeKey: "bk", fetchFn: backend({ useBirdeye: true }), smartMoney: parseSmartMoney([]) });
check("respects the limit", limited.tokens.length === 2, `got ${limited.tokens.length}`);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
