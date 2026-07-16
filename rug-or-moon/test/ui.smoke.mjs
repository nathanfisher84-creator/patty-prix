// Headless browser smoke-test of the real PWA UI. Serves index.html + a mocked
// /api/scan (wired to the real scanToken over mock on-chain data) and drives
// Chromium through a scan, asserting the verdict + flags render.
//
// Dev-only: needs playwright (`npm i -D playwright`). Run: node test/ui.smoke.mjs

import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { scanToken } from "../api/scan.mjs";

// Use the environment's pre-installed Chromium (its build may differ from the
// playwright npm version), resolved dynamically.
async function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    const dir = (await readdir(base)).find(d => /^chromium-\d+$/.test(d));
    const p = dir && join(base, dir, "chrome-linux", "chrome");
    if (p && existsSync(p)) return p;
  } catch { /* fall through */ }
  return undefined; // let playwright try its default
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

// Mocked on-chain backend → a clean token (mint/freeze revoked, deep liquidity).
const backend = async (url, opts) => {
  const j = o => ({ ok: true, json: async () => o });
  if (url.includes("dexscreener.com")) return j([{
    dexId: "raydium", priceUsd: "0.0000021", marketCap: 2_100_000, pairCreatedAt: Date.now() - 40 * 86_400_000,
    liquidity: { usd: 250_000 }, volume: { h24: 300_000 }, txns: { h24: { buys: 900, sells: 500 } },
    baseToken: { symbol: "BONK", name: "Bonk" }, info: { imageUrl: "" },
  }]);
  const body = JSON.parse(opts.body);
  if (body.method === "getAccountInfo") return j({ result: { value: { data: { parsed: { info: {
    mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000000000000000" } } } } } });
  if (body.method === "getTokenLargestAccounts") return j({ result: { value: [
    { uiAmount: 400_000_000 }, { uiAmount: 30_000_000 }, { uiAmount: 20_000_000 }] } });
  return j({});
};

const TYPES = { html: "text/html", json: "application/json", js: "text/javascript", svg: "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/scan") {
    const d = await scanToken(u.searchParams.get("token"), { heliusKey: "k", fetchFn: backend });
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(d));
  }
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  try {
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": TYPES[p.split(".").pop()] || "text/plain" }); res.end(buf);
  } catch { res.writeHead(404); res.end("nf"); }
});

let failures = 0;
const check = (n, c) => { console.log((c ? "  ✅ " : "  ❌ ") + n); if (!c) failures++; };

await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: await chromiumPath() });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await page.goto(base + "/?token=" + MINT, { waitUntil: "networkidle" });
  await page.waitForSelector(".verdict h2", { timeout: 8000 });

  const verdict = await page.textContent(".verdict h2");
  const score = await page.textContent(".ring b");
  const flags = await page.$$eval(".flags li", els => els.map(e => e.textContent.trim()));
  const buy = await page.getAttribute(".buy", "href");

  console.log("\nUI smoke test (real Chromium):");
  check("verdict rendered as 'Looks clean'", /Looks clean/.test(verdict));
  check("safety score shown (100)", score.trim() === "100");
  check("green flags rendered", flags.some(f => /revoked/i.test(f)));
  check("market row present ($BONK)", (await page.textContent(".market")).includes("BONK") || (await page.textContent(".sym")).includes("BONK"));
  check("Buy on Jupiter link points to jup.ag for the token", buy.includes("jup.ag") && buy.includes(MINT));
  check("disclaimer visible", /Not financial advice/i.test(await page.textContent(".disc")));

  await page.screenshot({ path: join(ROOT, "test", "ui-smoke.png") });
  console.log("  📸 screenshot: test/ui-smoke.png");
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
