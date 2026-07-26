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
const RAYDIUM = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j"; // recognized pool owner

// A mocked backend: DexScreener pairs + Helius getAccountInfo / getTokenLargestAccounts
// / getMultipleAccounts (owner resolution). `owners` maps token-account → owner.
// `ext` injects Token-2022 extensions.
const backend = ({ liq = 250_000, mintAuth = null, freezeAuth = null, holders, owners, ext, lpLockedPct, rugged, jupVerified, goplus, programs, pump = 0, dexId = "raydium", mcap = 2_100_000 } = {}) => async (url, opts) => {
  const j = o => ({ ok: true, json: async () => o });
  if (url.includes("rugcheck.xyz")) {
    return j({ rugged: !!rugged, markets: lpLockedPct != null ? [{ lp: { lpLockedPct } }] : [] });
  }
  if (url.includes("tokens.jup.ag")) return j({ tags: jupVerified ? ["verified"] : [] });
  if (url.includes("gopluslabs.io")) return j({ result: { [MINT]: goplus || {} } });
  if (url.includes("dexscreener.com")) {
    return j([{
      dexId, priceUsd: "0.0000021", marketCap: mcap,
      pairCreatedAt: Date.now() - 40 * 86_400_000,
      liquidity: { usd: liq, quote: liq / 200 }, volume: { h24: 300_000 }, txns: { h24: { buys: 800, sells: 500 } },
      priceChange: { h1: 0, h24: pump },
      baseToken: { symbol: "BONK", name: "Bonk" },
      info: { imageUrl: "http://img", websites: [{ url: "http://x" }], socials: [{ type: "twitter" }] },
    }]);
  }
  const body = JSON.parse(opts.body);
  if (body.method === "getAccountInfo")
    return j({ result: { value: { data: { program: ext ? "spl-token-2022" : "spl-token", parsed: { info: {
      mintAuthority: mintAuth, freezeAuthority: freezeAuth, decimals: 6, supply: "1000000000000000",
      ...(ext ? { extensions: ext } : {}),
    } } } } } }); // supply raw = 1e15 / 1e6 = 1e9 ui
  if (body.method === "getTokenLargestAccounts")
    return j({ result: { value: holders ?? [
      { address: "acct-pool", uiAmount: 400_000_000 },
      { address: "acct-1", uiAmount: 30_000_000 },
      { address: "acct-2", uiAmount: 20_000_000 },
    ] } });
  if (body.method === "getMultipleAccounts") {
    const addrs = body.params[0];
    // Each account carries BOTH: top-level `owner` (the program that owns the
    // account — used to detect AMM-PDA pool authorities) and parsed.info.owner
    // (the token account's authority). `programs` maps an authority → its owning
    // program; default is the System Program (a normal wallet).
    return j({ result: { value: addrs.map(a => ({
      owner: (programs || {})[a] || "11111111111111111111111111111111",
      data: { parsed: { info: { owner: (owners || {})[a] || ("owner-" + a) } } },
    })) } });
  }
  return j({});
};

console.log("\n1. Clean token — full scan (LP owner recognized → excluded)");
const clean = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM } }) });
check("returns the scored result", typeof clean.safety === "number" && clean.tier);
check("clean tier", clean.tier === "clean", `tier ${clean.tier} safety ${clean.safety}`);
check("market surfaced (symbol/liquidity)", clean.market.symbol === "BONK" && clean.market.liquidityUsd === 250_000);
check("surfaces socials/websites (was thrown away)", clean.market.socials.includes("twitter") && clean.market.websites.length === 1);
check("dataComplete true with Helius key", clean.dataComplete === true);
check("recognized LP excluded → low concentration", clean.concentration <= 0.06, `conc ${clean.concentration}`);

console.log("\n1b. General pool detection — any AMM's LP is excluded, not just Raydium");
// The pool account's authority is NOT a known fast-path address, but that
// authority is owned by the Orca Whirlpools program → detected as a pool.
const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const orcaPool = await scanToken(MINT, {
  heliusKey: "k",
  fetchFn: backend({
    holders: [{ address: "acct-pool", uiAmount: 400_000_000 }, { address: "acct-1", uiAmount: 30_000_000 }, { address: "acct-2", uiAmount: 20_000_000 }],
    owners: { "acct-pool": "orcaPoolPda" },   // authority isn't in the fast-path set
    programs: { "orcaPoolPda": ORCA },         // ...but it's owned by the Orca program
  }),
});
check("Orca LP excluded via program-owner check → low concentration", orcaPool.concentration <= 0.06, `conc ${orcaPool.concentration}`);
check("no 'large share in one wallet' hint when the pool is identified", !orcaPool.flags.some(f => f.id === "pool-unverified"));

console.log("\n2. Rug token — active authorities + low liquidity");
const rug = await scanToken(MINT, {
  heliusKey: "k",
  fetchFn: backend({ liq: 1_500, mintAuth: "Dev11111111111111111111111111111111111111", freezeAuth: "Dev11111111111111111111111111111111111111",
    holders: [{ address: "r1", uiAmount: 800_000_000 }, { address: "r2", uiAmount: 100_000_000 }] }),
});
check("high-risk tier", rug.tier === "high-risk", `tier ${rug.tier} safety ${rug.safety}`);
check("mint authority red flag", rug.flags.some(f => f.level === "red" && /Mint authority is ACTIVE/.test(f.text)));
check("low-liq token does NOT hide the top holder (counted)", rug.concentration >= 0.8, `conc ${rug.concentration}`);

console.log("\n3. No Helius key — authorities UNKNOWN, never faked as revoked (C1)");
const noKey = await scanToken(MINT, { fetchFn: backend() });
check("still returns market-based result", typeof noKey.safety === "number");
check("dataComplete false (authorities unknown)", noKey.dataComplete === false);
check("does NOT claim 'revoked' when unknown", !noKey.flags.some(f => /revoked/i.test(f.text)));
check("flags authority as unknown", noKey.flags.some(f => f.level === "yellow" && /unknown/i.test(f.text)));
check("unknown authorities cannot score 'clean'", noKey.tier !== "clean", `tier ${noKey.tier}`);

console.log("\n4. Dev whale LARGER than the pool is not hidden as 'pool' (C2 exploit)");
const whale = await scanToken(MINT, {
  heliusKey: "k",
  fetchFn: backend({ liq: 250_000,
    holders: [{ address: "whale", uiAmount: 600_000_000 }, { address: "pool", uiAmount: 400_000_000 }],
    owners: { pool: RAYDIUM, whale: "owner-whale" } }),
});
check("the dev whale is counted, not excluded", whale.concentration >= 0.5, `conc ${whale.concentration}`);
check("majority-held token cannot be 'clean'", whale.tier !== "clean", `tier ${whale.tier}`);

console.log("\n5. Token-2022 honeypot — permanent delegate + 100% transfer fee (C3)");
const t22 = await scanToken(MINT, {
  heliusKey: "k",
  fetchFn: backend({ ext: [
    { extension: "permanentDelegate", state: { delegate: "Dev11111111111111111111111111111111111111" } },
    { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 10000 } } },
  ], owners: { "acct-pool": RAYDIUM } }),
});
check("permanent-delegate red flag", t22.flags.some(f => f.level === "red" && /Permanent delegate/.test(f.text)));
check("transfer-tax red flag", t22.flags.some(f => f.level === "red" && /tax/i.test(f.text)));
check("honeypot forced to high-risk", t22.tier === "high-risk", `tier ${t22.tier}`);

console.log("\n5c. LP lock (RugCheck) — unlocked flagged, locked reassures, rugged = high-risk");
const unlocked = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, lpLockedPct: 10 }) });
check("low LP lock → red flag", unlocked.flags.some(f => f.level === "red" && /Liquidity is just/.test(f.text)));
check("low LP lock cannot be 'clean'", unlocked.tier !== "clean", `tier ${unlocked.tier}`);
check("surfaces lpLockedPct in the result", unlocked.lpLockedPct === 10);
const locked = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, lpLockedPct: 100 }) });
check("locked/burned LP → green flag", locked.flags.some(f => f.level === "green" && /locked\/burned/.test(f.text)));
check("locked LP token still clean", locked.tier === "clean", `tier ${locked.tier}`);
const ruggedTok = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, rugged: true }) });
check("RugCheck 'rugged' forces high-risk", ruggedTok.tier === "high-risk", `tier ${ruggedTok.tier}`);

console.log("\n5d. Cross-checks — Jupiter verified + GoPlus second opinion");
const verified = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, jupVerified: true }) });
check("Jupiter-verified → green flag", verified.flags.some(f => f.level === "green" && /verified token list/.test(f.text)));
check("sources report jupiter verified", verified.sources.jupiter === "verified");
const gp = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, goplus: { non_transferable: "1" } }) });
check("GoPlus danger → yellow second-opinion flag", gp.flags.some(f => f.level === "yellow" && /GoPlus/.test(f.text)));
check("GoPlus danger caps tier (not clean)", gp.tier !== "clean", `tier ${gp.tier}`);
check("sources mark goplus as flag", gp.sources.goplus === "flag");
const gpTrust = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, goplus: { trusted_token: "1" } }) });
check("GoPlus trusted → green flag, stays clean", gpTrust.flags.some(f => f.level === "green" && /trusted token/.test(f.text)) && gpTrust.tier === "clean");

console.log("\n5e. Pumping on thin liquidity (setup for 'cut supply on pump')");
const pumpThin = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, pump: 120, liq: 20_000, mcap: 3_000_000, dexId: "meteora" }) });
check("pumping + thin liquidity → yellow caution", pumpThin.flags.some(f => f.level === "yellow" && f.id === "pump-thin-liq"));
check("names the Meteora pool", /Meteora/.test((pumpThin.flags.find(f => f.id === "pump-thin-liq") || {}).text || ""));
const deepPump = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM }, pump: 120, liq: 250_000 }) });
check("pump on DEEP liquidity → no thin-liq flag", !deepPump.flags.some(f => f.id === "pump-thin-liq"));

console.log("\n6. Honeypot trading shape — many buys, ~0 sells → not bullish alpha");
const hp = async (url, opts) => {
  const j = o => ({ ok: true, json: async () => o });
  if (url.includes("rugcheck.xyz")) return j({ rugged: false, markets: [] });
  if (url.includes("tokens.jup.ag")) return j({ tags: [] });
  if (url.includes("gopluslabs.io")) return j({ result: {} });
  if (url.includes("dexscreener.com")) return j([{
    dexId: "raydium", priceUsd: "0.1", marketCap: 1e6, pairCreatedAt: Date.now() - 40 * 86_400_000,
    liquidity: { usd: 60_000 }, volume: { h24: 80_000 }, txns: { h24: { buys: 500, sells: 2 } },
    baseToken: { symbol: "TRAP", name: "Trap" }, info: {},
  }]);
  const body = JSON.parse(opts.body);
  if (body.method === "getAccountInfo") return j({ result: { value: { data: { program: "spl-token", parsed: { info: {
    mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000000000000" } } } } } });
  if (body.method === "getTokenLargestAccounts") return j({ result: { value: [{ address: "p", uiAmount: 1e8 }] } });
  if (body.method === "getMultipleAccounts") return j({ result: { value: body.params[0].map(() => ({ data: { parsed: { info: { owner: RAYDIUM } } } })) } });
  return j({});
};
const trap = await scanToken(MINT, { heliusKey: "k", fetchFn: hp });
check("honeypot red flag on no-sells", trap.flags.some(f => f.level === "red" && /honeypot/i.test(f.text)));
check("no-sells NOT scored as buy pressure", !/Buy pressure/.test(trap.alpha.signals.join(" ")));
check("honeypot forced to high-risk", trap.tier === "high-risk", `tier ${trap.tier}`);

console.log("\n7. Input validation");
check("rejects a bad address", (await scanToken("not-a-mint", {})).error != null);

console.log("\n8. Disclaimer always present");
check("carries the not-financial-advice disclaimer", /Not financial advice/.test(clean.disclaimer));

console.log("\n9. Smart-money alpha — resolves holder owners + flags overlap");
const sm = parseSmartMoney([{ wallet: "owner-acct-1", label: "Cupsey" }, { wallet: "owner-acct-2", label: "Whale2" }]);
const withSM = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM } }), smartMoney: sm });
check("alpha counts the smart-money holders", /2 tracked smart-money wallets holding/.test(withSM.alpha.signals.join(" ")), withSM.alpha.signals.join(" | "));
check("names the wallets from labels", /Cupsey/.test(withSM.alpha.signals.join(" ")));
check("marks smart money reliable when owners resolved", withSM.smartMoneyReliable === true);
const noSM = await scanToken(MINT, { heliusKey: "k", fetchFn: backend({ owners: { "acct-pool": RAYDIUM } }), smartMoney: parseSmartMoney([]) });
check("no smart-money list → no smart-money signal", !/smart-money wallet/.test(noSM.alpha.signals.join(" ")));

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
