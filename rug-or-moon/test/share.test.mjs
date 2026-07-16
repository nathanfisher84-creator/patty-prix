// Tests the OG share-card HTML builder. Run: node test/share.test.mjs
import { shareCardHtml } from "../api/share.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + name + (extra ? "  " + extra : ""));
  if (!cond) failures++;
};

const BASE = "https://patty-prix-rxu7.vercel.app";
const TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

console.log("\n1. High-risk verdict unfurls with the scary summary");
const rug = shareCardHtml({
  safety: 3, tier: "high-risk", market: { symbol: "SAFEMOON2" },
  flags: [{ level: "red", id: "mint-authority", text: "Mint authority is ACTIVE — creator can mint unlimited tokens" }],
}, TOKEN, BASE);
check("og:title carries the score + verdict", /og:title" content="[^"]*3\/100[^"]*High risk/.test(rug));
check("og:title names the token", /\$SAFEMOON2/.test(rug));
check("og:description carries the top flag", /Mint authority is ACTIVE/.test(rug));
check("og:image points at the icon", /og:image" content="https:\/\/[^"]*icon-512\.png/.test(rug));
check("redirects humans to the app", rug.includes(`location.replace("https://patty-prix-rxu7.vercel.app/?token=${TOKEN}")`));
check("has a twitter card", /twitter:card/.test(rug));

console.log("\n2. Clean verdict unfurls with the reassuring summary");
const clean = shareCardHtml({ safety: 100, tier: "clean", market: { symbol: "BONK" }, flags: [{ level: "green", id: "mint-authority", text: "Mint authority revoked" }] }, TOKEN, BASE);
check("title says looks clean", /Looks clean/.test(clean));
check("description falls back to DYOR when no red/yellow flags", /DYOR/.test(clean));

console.log("\n3. Errored / unknown token still returns a valid page");
const err = shareCardHtml({ error: "invalid token address" }, TOKEN, BASE);
check("generic title on error", /Rug or Moon/.test(err));
check("still redirects", err.includes("location.replace"));

console.log("\n4. Escaping — a malicious symbol can't inject markup");
const evil = shareCardHtml({ safety: 10, tier: "high-risk", market: { symbol: '"><script>x</script>' }, flags: [] }, TOKEN, BASE);
check("no raw <script> from the symbol", !/<script>x<\/script>/.test(evil));
check("angle brackets escaped in the title", /&lt;script&gt;/.test(evil));

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
