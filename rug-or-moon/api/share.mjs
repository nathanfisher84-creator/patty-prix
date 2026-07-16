// Vercel serverless endpoint: GET /api/share?token=<mint>
//
// The viral loop. When someone pastes this link into Telegram / X / Discord, the
// crawler reads the Open Graph tags below and unfurls the verdict ("🚩 $FOO 3/100
// — High risk"), so the scan spreads itself. Humans are redirected straight into
// the app. Dependency-free: crawlers read the meta tags, browsers run the redirect.

import { scanToken } from "./scan.mjs";
import { VERDICT } from "../scoring.mjs";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Pure + testable: build the share HTML from a scan result.
export function shareCardHtml(result, token, baseUrl) {
  const appUrl = `${baseUrl}/?token=${encodeURIComponent(token)}`;
  const img = `${baseUrl}/icons/icon-512.png`;

  let title, desc;
  if (!result || result.error) {
    title = "Rug or Moon — Solana token safety scanner";
    desc = "Scan any Solana token for rug red flags and smart-money signals before you ape.";
  } else {
    const v = VERDICT[result.tier] || VERDICT.caution;
    const sym = result.market?.symbol ? "$" + result.market.symbol : "token";
    title = `${v.emoji} ${sym} — ${result.safety}/100 · ${v.label} | Rug or Moon`;
    const notable = (result.flags || []).filter(f => f.level !== "green").slice(0, 3).map(f => f.text);
    desc = notable.length ? notable.join(" · ") : "No major red flags — still DYOR.";
  }

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:image" content="${esc(img)}" />
<meta property="og:url" content="${esc(appUrl)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(img)}" />
<meta http-equiv="refresh" content="0; url=${esc(appUrl)}" />
<link rel="canonical" href="${esc(appUrl)}" />
<script>location.replace(${JSON.stringify(appUrl)});</script>
</head><body>
<p>Opening the scan for this token… <a href="${esc(appUrl)}">Continue to Rug or Moon</a>.</p>
</body></html>`;
}

export default async function handler(req, res) {
  const token = (req.query?.token || "").trim();
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers.host;
  const baseUrl = `${proto}://${host}`;

  if (!token) { res.statusCode = 302; res.setHeader("location", "/"); return res.end(); }

  let result = null;
  try {
    result = await scanToken(token, { heliusKey: process.env.HELIUS_API_KEY });
  } catch { result = { error: "scan failed" }; }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=300");
  res.statusCode = 200;
  return res.end(shareCardHtml(result, token, baseUrl));
}
