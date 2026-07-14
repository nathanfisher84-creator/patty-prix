// THE PRINT SHOP: prompt the Bagworker into any fit. Sends the base
// character image + a strict consistency instruction + the user's
// outfit prompt to Gemini's image model (server-side key, GEMINI_API_KEY
// in Vercel env). Costs real money per image, so it's throttled hard:
// per-visitor daily allowance plus a global daily cap in the same
// Upstash KV as everything else. 501 until the key is configured.

import { createHash } from "crypto";
import { kvEnv, kvPipeline } from "./track.mjs";

const MINT = "2jz9E5JrEbxLg1RhU68aaSikDvpQurCEZz9BBF9rpump";
const MODEL = "gemini-2.5-flash-image";
const PER_VISITOR_PER_DAY = 8;
const GLOBAL_PER_DAY = 150; // hard spend ceiling (~$6/day at ~4c each)
const DAY_TTL = 60 * 60 * 24 * 2;

const CONSISTENCY = "Edit this exact cartoon character. CRITICAL: the character must stay " +
  "100% identical and instantly recognizable — same blue skin with darker blue dash markings, " +
  "same long droopy nose, same forehead wrinkle lines, same iridescent blue shield sunglasses, " +
  "same body proportions, same thick black outline sticker art style. Change ONLY what is " +
  "requested, keep a clean simple background, square 1:1 composition. Requested change: ";

// the base art is fetched once per warm function: prefer a hi-res
// bagworker-base.png committed to the site, fall back to the token's
// official DexScreener icon
let baseCache = null;
async function baseImage() {
  if (baseCache) return baseCache;
  try {
    const r = await fetch("https://pattyprix.xyz/bagworker-base.png", { redirect: "follow" });
    const ct = r.headers.get("content-type") || "";
    if (r.ok && ct.startsWith("image/")) {
      baseCache = { mime: ct.split(";")[0], b64: Buffer.from(await r.arrayBuffer()).toString("base64") };
      return baseCache;
    }
  } catch { /* fall through to the token icon */ }
  const pairs = await (await fetch("https://api.dexscreener.com/token-pairs/v1/solana/" + MINT)).json();
  const score = (p) => (p.dexId === "pumpswap" ? 1e15 : 0) + (p.liquidity?.usd || 0);
  const best = (pairs || []).sort((a, b) => score(b) - score(a))[0];
  const url = best?.info?.imageUrl;
  if (!url) throw new Error("no base art available");
  const img = await fetch(url);
  const ct = (img.headers.get("content-type") || "image/png").split(";")[0];
  baseCache = { mime: ct, b64: Buffer.from(await img.arrayBuffer()).toString("base64") };
  return baseCache;
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(501).json({ error: "print shop not configured — add GEMINI_API_KEY in Vercel" });
  const kv = kvEnv();
  if (!kv) return res.status(501).json({ error: "print shop needs the KV store for rate limiting" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const prompt = String(body?.prompt ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (prompt.length < 3) return res.status(400).json({ error: "describe the fit — a few words minimum" });
  if (prompt.length > 300) return res.status(400).json({ error: "keep the prompt under 300 characters" });

  // spend guards: per-visitor allowance + global daily ceiling
  const day = new Date().toISOString().slice(0, 10);
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const visitor = createHash("sha256").update(ip + (req.headers["user-agent"] || "")).digest("hex").slice(0, 12);
  const meKey = "gp:" + day + ":" + visitor;
  const allKey = "gp:total:" + day;
  const gate = await kvPipeline([
    ["INCR", meKey], ["EXPIRE", meKey, DAY_TTL],
    ["INCR", allKey], ["EXPIRE", allKey, DAY_TTL]
  ], kv);
  const mine = Number(gate[0]?.result) || 0;
  const all = Number(gate[2]?.result) || 0;
  if (all > GLOBAL_PER_DAY) {
    return res.status(429).json({ error: "the print shop hit today's global limit — reopens tomorrow 🖨️" });
  }
  if (mine > PER_VISITOR_PER_DAY) {
    return res.status(429).json({ error: "you've used today's " + PER_VISITOR_PER_DAY + " prints — back tomorrow!" });
  }

  try {
    const base = await baseImage();
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent",
      {
        method: "POST",
        // the modern auth header — required for the new AQ.* key format
        headers: { "content-type": "application/json", "x-goog-api-key": key.trim() },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: base.mime, data: base.b64 } },
              { text: CONSISTENCY + prompt }
            ]
          }]
        })
      }
    );
    const j = await r.json();
    if (!r.ok) {
      const msg = j?.error?.message || "generation failed";
      return res.status(502).json({ error: msg.slice(0, 200) });
    }
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
    if (!img) {
      // usually the safety filter — tell the user to prompt nicer
      return res.status(422).json({ error: "the model declined that one — try a different fit" });
    }
    const data = img.inlineData?.data || img.inline_data?.data;
    const mime = img.inlineData?.mimeType || img.inline_data?.mime_type || "image/png";
    return res.status(200).json({
      ok: true,
      image: "data:" + mime + ";base64," + data,
      left: Math.max(0, PER_VISITOR_PER_DAY - mine)
    });
  } catch (err) {
    return res.status(502).json({ error: String(err && err.message || err).slice(0, 200) });
  }
}
