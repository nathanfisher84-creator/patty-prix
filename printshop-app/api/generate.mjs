// THE PRINT SHOP (standalone deployment). Prompt the Bagworker into any
// fit via Gemini's image model (Nano Banana Pro by default). This copy
// is fully self-contained so it can run as its own Vercel project with
// its own URL, separate from the main paused site.
//
// Env vars this project needs in Vercel:
//   GEMINI_API_KEY            (required)
//   KV_REST_API_URL           } Upstash Redis REST — same DB as the main
//   KV_REST_API_TOKEN         }  site is fine; used only for rate limiting
//   PRINT_MODEL               (optional) override the model id
//   PRINT_PER_VISITOR         (optional) daily prints per visitor  [5]
//   PRINT_GLOBAL              (optional) daily prints site-wide    [100]

import { createHash } from "crypto";

const MINT = "2jz9E5JrEbxLg1RhU68aaSikDvpQurCEZz9BBF9rpump";
const MODEL = (process.env.PRINT_MODEL || "gemini-3-pro-image-preview").trim();
const PER_VISITOR_PER_DAY = Number(process.env.PRINT_PER_VISITOR || 5);
const GLOBAL_PER_DAY = Number(process.env.PRINT_GLOBAL || 100);
const DAY_TTL = 60 * 60 * 24 * 2;         // per-visitor rate-limit window
const HIST_TTL = 60 * 60 * 24 * 40;       // keep daily totals for the dashboard

const CONSISTENCY = "Edit this exact cartoon character. CRITICAL: the character must stay " +
  "100% identical and instantly recognizable — same blue skin with darker blue dash markings, " +
  "same long droopy nose, same forehead wrinkle lines, same iridescent blue shield sunglasses, " +
  "same body proportions, same thick black outline sticker art style. Change ONLY what is " +
  "requested, keep a clean simple background, square 1:1 composition. Requested change: ";

function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}
async function kvPipeline(cmds, kv) {
  const r = await fetch(kv.url + "/pipeline", {
    method: "POST",
    headers: { authorization: "Bearer " + kv.token, "content-type": "application/json" },
    body: JSON.stringify(cmds)
  });
  return r.json();
}

// base art: the canonical Bagworker served from the main domain (that
// path is exempt from the maintenance pause), falling back to the token
// icon if it's ever unreachable
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

  const day = new Date().toISOString().slice(0, 10);
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const visitor = createHash("sha256").update(ip + (req.headers["user-agent"] || "")).digest("hex").slice(0, 12);
  const meKey = "gp:" + day + ":" + visitor;
  const allKey = "gp:total:" + day;
  const gate = await kvPipeline([
    ["INCR", meKey], ["EXPIRE", meKey, DAY_TTL],
    ["INCR", allKey], ["EXPIRE", allKey, HIST_TTL],
    ["INCR", "gp:alltime"]
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
