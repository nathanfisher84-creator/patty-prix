// Stamp brand.json across the site. Idempotent: run it any time
// (locally or via .github/workflows/brand.yml) after editing brand.json.
//
//   node scripts/apply-brand.mjs
//
// Three mechanisms:
//   1. marker regions   — blocks fully regenerated from brand.json
//                         (/* brand:theme */ CSS vars, <!-- brand:lore -->,
//                          /* brand:consistency */ AI prompt)
//   2. context rules    — values replaced wherever a known pattern holds
//                         them (mint addresses in consts and swap URLs,
//                         airdrop wallet, chart pair, X handle, banners,
//                         Google Fonts link)
//   3. tracked literals — free-text strings (ticker, names, catchphrases)
//                         swapped verbatim old→new; brand.json's _applied
//                         block remembers what's currently stamped.
//
// NOT covered (change by hand / ask Claude): domains, page structure,
// niche flavor copy, the mascot artwork itself.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const brandPath = join(ROOT, "brand.json");
const brand = JSON.parse(readFileSync(brandPath, "utf8"));
const applied = brand._applied || {};

const FILES = [
  "index.html", "game.html", "leaderboard.html", "printshop.html",
  "airdrops.html", "maintenance.html", "dashboard.html",
  "printshop-app/index.html", "printshop-app/dashboard.html",
  "api/generate.mjs", "api/stats.mjs", "printshop-app/api/generate.mjs",
  "scripts/telegram-scoreboard.mjs",
].filter((f) => existsSync(join(ROOT, f)));

const warnings = [];
const texts = new Map(FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

// ── 1. marker regions ──────────────────────────────────────────────
function region(file, open, close, body) {
  if (!texts.has(file)) return;
  const s = texts.get(file);
  const re = new RegExp(esc(open) + "[\\s\\S]*?" + esc(close));
  if (!re.test(s)) { warnings.push(`${file}: marker ${open} not found`); return; }
  texts.set(file, s.replace(re, open + "\n" + body + "\n" + close));
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const t = brand.theme;
const rgbOf = (h) => { const n = parseInt(h.slice(1), 16); return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`; };
const themeBody =
  `    --bg: ${t.bg}; --card: ${t.card}; --stripe: ${t.stripe}; --edge: ${t.edge};\n` +
  `    --ink: ${t.ink}; --sub: ${t.sub}; --accent: ${t.accent}; --accent2: ${t.accent2};\n` +
  `    --red: ${t.red}; --accent-rgb: ${rgbOf(t.accent)}; --accent2-rgb: ${rgbOf(t.accent2)};`;
for (const f of ["index.html", "game.html", "leaderboard.html", "printshop.html",
                 "airdrops.html", "maintenance.html", "printshop-app/index.html"]) {
  region(f, "/* brand:theme */", "/* /brand:theme */", themeBody);
}

region("index.html", "<!-- brand:lore -->", "<!-- /brand:lore -->",
  brand.copy.loreHtml.map((l) => "      " + l).join("\n"));

const consistency =
  `const CONSISTENCY = ${JSON.stringify(
    "Edit this exact cartoon character. Keep the character's IDENTITY 100% consistent and instantly recognizable: " +
    brand.ai.characterPrompt +
    ". You MAY change the pose, body position and camera angle so the requested outfit or scene looks natural and dynamic. " +
    brand.ai.scenePrompt +
    " Square 1:1 composition. Requested change: "
  )};`;
region("api/generate.mjs", "/* brand:consistency */", "/* /brand:consistency */", consistency);
region("printshop-app/api/generate.mjs", "/* brand:consistency */", "/* /brand:consistency */", consistency);

// ── 2. context rules ───────────────────────────────────────────────
const B58 = "[1-9A-HJ-NP-Za-km-z]{25,50}";
function rule(re, replacement, expected = false) {
  let matched = 0;
  for (const [f, s] of texts) {
    if (!re.test(s)) continue;
    matched++;
    re.lastIndex = 0;
    texts.set(f, s.replace(re, replacement));
  }
  if (!matched && expected) warnings.push(`rule ${re} matched nothing`);
}

rule(new RegExp(`(const MINT = ")${B58}(")`, "g"), `$1${brand.token.mint}$2`, true);
rule(new RegExp(`(challenger: ")${B58}(")`, "g"), `$1${brand.token.mint}$2`, true);
rule(new RegExp(`(mint: ")${B58}(")`, "g"), `$1${brand.token.mint}$2`, true);
rule(new RegExp(`(const AIRDROP_WALLET = ")${B58}(")`, "g"), `$1${brand.wallets.airdrop}$2`, true);
rule(new RegExp(`(airdropWallet: ")${B58}(")`, "g"), `$1${brand.wallets.airdrop}$2`, true);
rule(new RegExp(`(jup\\.ag/swap/SOL-)${B58}`, "g"), `$1${brand.token.mint}`, true);
rule(new RegExp(`(pump\\.fun/coin/)${B58}`, "g"), `$1${brand.token.mint}`, true);
rule(new RegExp(`(bubblemaps\\.io/sol/token/)${B58}`, "g"), `$1${brand.token.mint}`, true);
rule(new RegExp(`(dexscreener\\.com/solana/)${B58}`, "g"), `$1${brand.token.pairAddress}`, true);
rule(new RegExp(`(https://x\\.com/)[A-Za-z0-9_]+`, "g"), `$1${brand.links.xHandle}`, true);
rule(/const BANNERS = \[[^\]]*\];/,
  `const BANNERS = [${brand.copy.banners.map((b) => JSON.stringify(b)).join(", ")}];`, true);

// fonts: only on pages that carry the brand theme (the dashboards keep
// their own look and their own font stack)
const fontsHref = "https://fonts.googleapis.com/css2?family=" +
  [t.fontBody, t.fontDisplay].map((f) => f.replaceAll(" ", "+")).join("&family=") + "&display=swap";
for (const [f, s] of texts) {
  if (!s.includes("/* brand:theme */")) continue;
  texts.set(f, s.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*" rel="stylesheet">/g,
    `<link href="${fontsHref}" rel="stylesheet">`));
}

// ── 3. tracked literals (old → new, case-aware) ────────────────────
const LITERALS = [
  ["name", brand.token.name, { upper: true }],
  ["gameName", brand.copy.gameName, { upper: true }],
  ["gameOver", brand.copy.gameOver, { upper: true }],
  ["catchphraseA", brand.copy.catchphraseA, { upper: true }],
  ["catchphraseB", brand.copy.catchphraseB, { upper: true }],
  ["whoTitle", brand.copy.whoTitle, { upper: false }],
  // after full name on purpose; no upper variant — its uppercase form
  // could collide with the ticker ("Jared" → "JARED")
  ["shortName", brand.token.shortName, { upper: false }],
  ["baseImage", brand.ai.baseImage, { upper: false }],
  ["fontDisplay", `'${t.fontDisplay}'`, { upper: false }],
  ["fontBody", `'${t.fontBody}'`, { upper: false }],
];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function swapLiteral(oldV, newV, upper = true) {
  if (!oldV || oldV === newV) return;
  for (const [f, s] of texts) {
    let out = s.split(oldV).join(newV);
    out = out.split(cap(oldV)).join(cap(newV));
    if (upper) out = out.split(oldV.toUpperCase()).join(newV.toUpperCase());
    if (out !== s) texts.set(f, out);
  }
}
// ticker gets the $ prefix so bare substrings can't misfire
swapLiteral("$" + (applied.ticker || brand.token.ticker), "$" + brand.token.ticker);
applied.ticker = brand.token.ticker;
for (const [key, newV, opts] of LITERALS) {
  const oldV = key.startsWith("font")
    ? (applied[key] ? `'${applied[key]}'` : newV)
    : (applied[key] ?? newV);
  swapLiteral(oldV, newV, opts.upper);
  applied[key] = key.startsWith("font") ? newV.slice(1, -1) : newV;
}

// ── write out ──────────────────────────────────────────────────────
let changed = 0;
for (const [f, s] of texts) {
  const p = join(ROOT, f);
  if (readFileSync(p, "utf8") !== s) { writeFileSync(p, s); changed++; console.log("stamped", f); }
}
brand._applied = applied;
const newBrand = JSON.stringify(brand, null, 2) + "\n";
if (readFileSync(brandPath, "utf8") !== newBrand) { writeFileSync(brandPath, newBrand); console.log("updated brand.json bookkeeping"); }

for (const w of warnings) console.warn("WARN:", w);
console.log(changed ? `done — ${changed} file(s) updated` : "done — everything already up to date");
