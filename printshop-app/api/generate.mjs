// THE PRINT SHOP (standalone deployment). Prompt Jared into any
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

const MINT = "98UYfFK6VFNTpv2Hp7NYy4yLdzvCfcpv69TuJgYdpump";
const MODEL = (process.env.PRINT_MODEL || "gemini-3.1-flash-image-preview").trim();
// callers may request a specific image model from this allow-list (used
// for A/B comparisons); anything else falls back to MODEL
const MODEL_ALLOW = new Set([
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview", "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image-preview", "gemini-3.1-flash-lite-image",
  "gemini-2.5-flash-image"
]);
const GLOBAL_PER_DAY = Number(process.env.PRINT_GLOBAL || 200);
// per-visitor cap read per-request; 0 (default) = no per-person limit
const DAY_TTL = 60 * 60 * 24 * 2;         // per-visitor rate-limit window
const HIST_TTL = 60 * 60 * 24 * 40;       // keep daily totals for the dashboard
const JOB_TTL = 60 * 15;                  // recover a finished print for 15 min
const SID_RE = /^[a-z0-9]{8,64}$/i;       // client session id for recovery
// scheduled shutoff — after this the endpoint refuses to spend. Schedule
// one any time with the PRINT_SHUTOFF env var ("off" = always open).
const SHUTOFF_DEFAULT = "off";

/* brand:consistency */
const CONSISTENCY = "Edit this exact cartoon character. Keep the character's IDENTITY 100% consistent and instantly recognizable: same pale-skinned man with a sly smug grin, same glowing bright green eyes, same dark navy hooded hoodie with the hood up, same green neon rim-lighting, same bold comic style with dark outlines. You MAY change the pose, body position and camera angle so the requested outfit or scene looks natural and dynamic. Keep the dark hacker / matrix-code mood of the background unless the request implies a different scene. Square 1:1 composition. Requested change: ";
/* /brand:consistency */

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

function getQuery(req) {
  if (req.query && typeof req.query === "object") return req.query;
  try { return Object.fromEntries(new URL(req.url, "http://x").searchParams); } catch { return {}; }
}

// base art: the canonical Jared served from the main domain (that
// path is exempt from the maintenance pause), falling back to the token
// icon if it's ever unreachable
let baseCache = null;
async function baseImage() {
  if (baseCache) return baseCache;
  // the site may answer on either domain while the move to
  // jaredfromsubway.xyz completes — try both before the icon fallback
  for (const url of ["https://jaredfromsubway.xyz/extractor-base.png", "https://pattyprix.xyz/extractor-base.png"]) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.startsWith("image/")) {
        baseCache = { mime: ct.split(";")[0], b64: Buffer.from(await r.arrayBuffer()).toString("base64") };
        return baseCache;
      }
    } catch { /* try the next source */ }
  }
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

  // recovery: mobile tabs abort the POST when backgrounded, but the paid
  // generation still finishes and gets cached — hand it back by session id
  if (req.method === "GET") {
    const sid = String(getQuery(req).sid || "").trim();
    if (!SID_RE.test(sid)) return res.status(400).json({ error: "bad recovery id" });
    const kv = kvEnv();
    if (!kv) return res.status(501).json({ error: "print shop needs the KV store" });
    try {
      const out = await kvPipeline([["GET", "printjob:" + sid]], kv);
      const raw = out?.[0]?.result;
      if (!raw) return res.status(404).json({ pending: true });
      res.setHeader("cache-control", "no-store");
      return res.status(200).json(JSON.parse(raw));
    } catch { return res.status(404).json({ pending: true }); }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(501).json({ error: "print shop not configured — add GEMINI_API_KEY in Vercel" });
  const kv = kvEnv();
  if (!kv) return res.status(501).json({ error: "print shop needs the KV store for rate limiting" });

  // hard off-switch once the countdown ends
  const shutoff = Date.parse(process.env.PRINT_SHUTOFF || SHUTOFF_DEFAULT);
  if (Number.isFinite(shutoff) && Date.now() > shutoff) {
    return res.status(503).json({ closed: true, error: "the print shop has closed 🌙" });
  }

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
  const perVisitorCap = Number(process.env.PRINT_PER_VISITOR || 0); // 0 = unlimited
  const cmds = [["INCR", allKey], ["EXPIRE", allKey, HIST_TTL], ["INCR", "gp:alltime"]];
  if (perVisitorCap > 0) cmds.push(["INCR", meKey], ["EXPIRE", meKey, DAY_TTL]);
  const gate = await kvPipeline(cmds, kv);
  const all = Number(gate[0]?.result) || 0;
  const mine = perVisitorCap > 0 ? (Number(gate[3]?.result) || 0) : 0;
  if (all > GLOBAL_PER_DAY) {
    return res.status(429).json({ error: "the print shop hit today's global limit — reopens tomorrow 🖨️" });
  }
  if (perVisitorCap > 0 && mine > perVisitorCap) {
    return res.status(429).json({ error: "you've used today's " + perVisitorCap + " prints — back tomorrow!" });
  }

  const model = (typeof body?.model === "string" && MODEL_ALLOW.has(body.model)) ? body.model : MODEL;

  try {
    const base = await baseImage();
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
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
    const payload = {
      ok: true,
      image: "data:" + mime + ";base64," + data,
      model,
      left: perVisitorCap > 0 ? Math.max(0, perVisitorCap - mine) : Math.max(0, GLOBAL_PER_DAY - all),
      ts: Date.now()
    };
    // stash it so a backgrounded mobile tab can pick the print back up.
    // best-effort — never let a cache hiccup fail the (already-paid) print
    const sid = String(body?.sid || "").trim();
    if (SID_RE.test(sid)) {
      try { await kvPipeline([["SET", "printjob:" + sid, JSON.stringify(payload), "EX", JOB_TTL]], kv); } catch { /* recovery just won't be available */ }
    }
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(502).json({ error: String(err && err.message || err).slice(0, 200) });
  }
}
