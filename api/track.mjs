// Self-owned visit counter. Stores daily page views and approximate
// unique visitors in Upstash Redis (add it free via Vercel Marketplace:
// project → Storage → Upstash Redis → connect; env vars are injected
// automatically). Responds 501 until that's configured.
//
// Privacy: visitors are counted via a one-way hash of (day + IP + UA)
// in a HyperLogLog — no IPs or identities are ever stored.

import { createHash } from "crypto";

export function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export async function kvPipeline(cmds, kv, fetchFn = fetch) {
  const r = await fetchFn(kv.url + "/pipeline", {
    method: "POST",
    headers: { authorization: "Bearer " + kv.token, "content-type": "application/json" },
    body: JSON.stringify(cmds)
  });
  return r.json();
}

const DAY_TTL = 60 * 60 * 24 * 40; // keep daily keys for 40 days

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  const kv = kvEnv();
  if (!kv) return res.status(501).json({ error: "visit tracking not configured" });

  const day = new Date().toISOString().slice(0, 10);
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ua = req.headers["user-agent"] || "";
  const visitor = createHash("sha256").update(day + ip + ua).digest("hex").slice(0, 16);

  try {
    await kvPipeline([
      ["INCR", "pv:total"],
      ["INCR", "pv:" + day],
      ["EXPIRE", "pv:" + day, DAY_TTL],
      ["PFADD", "uv:" + day, visitor],
      ["EXPIRE", "uv:" + day, DAY_TTL]
    ], kv);
    return res.status(204).end();
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
