// Generate dApp Store listing screenshots (portrait phone frames) from the real
// UI, driven over mocked on-chain data so they're deterministic and offline.
// Output: store/screenshot-*.png at 1080×2340 (a tall phone ratio). Run:
//   node scripts/screenshots.mjs
//
// These are drafts you can ship as-is or replace with captures from a real
// device. The store wants a few portrait screenshots ≥1080px on the long edge.

import http from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { scanToken } from "../api/scan.mjs";
import { scanTrending } from "../api/trending.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    const dir = (await readdir(base)).find(d => /^chromium-\d+$/.test(d));
    const p = dir && join(base, dir, "chrome-linux", "chrome");
    if (p && existsSync(p)) return p;
  } catch { /* fall through */ }
  return undefined;
}

const CLEAN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // → clean, $BONK
const RUG = "RugP111111111111111111111111111111111111111"; // valid BASE58, → high-risk

// Deterministic mocked backend: CLEAN scores high, everything else looks risky.
const backend = async (url, opts) => {
  const j = o => ({ ok: true, json: async () => o });
  if (url.includes("rugcheck.xyz")) {
    const mint = url.split("/tokens/")[1]?.split("/")[0];
    return j({ rugged: false, markets: [{ lp: { lpLockedPct: mint === CLEAN ? 100 : 8 } }] });
  }
  if (url.includes("token-boosts")) return j([
    { chainId: "solana", tokenAddress: CLEAN }, { chainId: "solana", tokenAddress: "So11111111111111111111111111111111111111112" },
    { chainId: "solana", tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  ]);
  if (url.includes("dexscreener.com/token-pairs")) {
    const mint = url.split("/").pop();
    const clean = mint === CLEAN;
    return j([{
      dexId: "raydium", priceUsd: clean ? "0.0000210" : "0.0000004",
      marketCap: clean ? 2_100_000 : 60_000, pairCreatedAt: Date.now() - (clean ? 40 : 0.3) * 86_400_000,
      liquidity: { usd: clean ? 250_000 : 1_800 }, volume: { h24: clean ? 300_000 : 90_000 },
      txns: { h24: { buys: clean ? 900 : 120, sells: clean ? 480 : 400 } },
      baseToken: { symbol: clean ? "BONK" : "SAFEMOON2", name: clean ? "Bonk" : "Definitely Legit" },
      info: clean
        ? { imageUrl: "", websites: [{ url: "https://bonk.example" }], socials: [{ type: "twitter" }, { type: "telegram" }] }
        : { imageUrl: "" },
    }]);
  }
  const body = JSON.parse(opts.body);
  const mint = body.params?.[0];
  const clean = mint === CLEAN;
  if (body.method === "getAccountInfo") return j({ result: { value: { data: { parsed: { info: {
    mintAuthority: clean ? null : "Dev1111111111111111111111111111111111111111",
    freezeAuthority: clean ? null : "Dev1111111111111111111111111111111111111111",
    decimals: 6, supply: "1000000000000000" } } } } } });
  if (body.method === "getTokenLargestAccounts") return j({ result: { value: clean
    ? [{ address: "pool", uiAmount: 400_000_000 }, { address: "a", uiAmount: 30_000_000 }, { address: "b", uiAmount: 20_000_000 }]
    : [{ address: "w", uiAmount: 900_000_000 }, { address: "x", uiAmount: 60_000_000 }] } });
  if (body.method === "getMultipleAccounts") return j({ result: { value: (body.params[0] || []).map(a => ({ data: { parsed: { info: { owner: a === "pool" ? "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j" : "o-" + a } } } })) } });
  return j({});
};

const TYPES = { html: "text/html", json: "application/json", js: "text/javascript", svg: "image/svg+xml", png: "image/png" };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/scan") {
    const d = await scanToken(u.searchParams.get("token"), { heliusKey: "k", fetchFn: backend });
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(d));
  }
  if (u.pathname === "/api/trending") {
    const d = await scanTrending({ limit: 12, heliusKey: "k", fetchFn: backend });
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(d));
  }
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  try {
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": TYPES[p.split(".").pop()] || "text/plain" }); res.end(buf);
  } catch { res.writeHead(404); res.end("nf"); }
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const outDir = join(ROOT, "store");
await mkdir(outDir, { recursive: true });

// 360 CSS px × deviceScaleFactor 3 = 1080 px wide; height 780 → 2340 tall.
const VW = 360, VH = 780, DSF = 3;
const browser = await chromium.launch({ executablePath: await chromiumPath() });
try {
  const shot = async (name, path, prep) => {
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF });
    const page = await ctx.newPage();
    await page.goto(base + path, { waitUntil: "networkidle" });
    if (prep) await prep(page);
    await page.screenshot({ path: join(outDir, name) });
    await ctx.close();
    console.log(`  📸 store/${name}`);
  };

  // 1) Hero — a clean token result.
  await shot("screenshot-1-clean.png", "/?token=" + CLEAN, async p => {
    await p.waitForSelector(".verdict h2", { timeout: 8000 });
  });
  // 2) A rug — red flags on display.
  await shot("screenshot-2-rug.png", "/?token=" + RUG, async p => {
    await p.waitForSelector(".flags li", { timeout: 8000 });
  });
  // 3) Trending board.
  await shot("screenshot-3-trending.png", "/", async p => {
    await p.click('.tabs button[data-tab="trending"]');
    await p.waitForSelector("#tab-trending .row", { timeout: 8000 });
  });
  // 4) Seeker Edition watchlist (unlimited unlocked).
  await shot("screenshot-4-seeker.png", "/?edition=seeker&token=" + CLEAN, async p => {
    await p.waitForSelector(".verdict h2", { timeout: 8000 });
    await p.click("#watchBtn");
    await p.click('.tabs button[data-tab="watch"]');
    await p.waitForSelector("#tab-watch .row", { timeout: 4000 });
  });
} finally {
  await browser.close();
  server.close();
}
console.log("\nDone. 1080×2340 portrait screenshots in store/.");
