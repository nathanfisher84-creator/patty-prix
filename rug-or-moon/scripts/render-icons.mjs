// Render the PNG app icons the manifest references, from icon.svg, using the
// environment's Chromium. Run: node scripts/render-icons.mjs
//
// Produces icons/icon-192.png, icon-512.png, and icon-512-maskable.png.
// The maskable variant scales the shield into the center safe zone (~80%) so
// Android can crop it to any shape without clipping the logo.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

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

const svg = await readFile(join(ROOT, "icons", "icon.svg"), "utf8");
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// Maskable: full-bleed solid background (no rounded corners / transparency — the
// OS applies its own mask), with the shield art scaled to 82% around the
// 256,256 center so it sits inside the maskable safe zone and never gets cropped.
const maskableInner =
  '<rect width="512" height="512" fill="#0b0f17"/>' +
  '<g transform="translate(256 256) scale(0.82) translate(-256 -256)">' +
  inner.replace(/<rect width="512" height="512"[^>]*\/>/, "") +
  "</g>";

const wrap = (body, size) =>
  `<!doctype html><meta charset=utf-8><style>*{margin:0}html,body{background:transparent}</style>` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${body}</svg>`;

const targets = [
  { file: "icon-192.png", size: 192, body: inner },
  { file: "icon-512.png", size: 512, body: inner },
  { file: "icon-512-maskable.png", size: 512, body: maskableInner },
];

const browser = await chromium.launch({ executablePath: await chromiumPath() });
try {
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
    await page.setContent(wrap(t.body, t.size), { waitUntil: "networkidle" });
    const el = await page.$("svg");
    const png = await el.screenshot({ omitBackground: true });
    await writeFile(join(ROOT, "icons", t.file), png);
    await page.close();
    console.log(`  ✅ icons/${t.file} (${t.size}×${t.size}, ${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
