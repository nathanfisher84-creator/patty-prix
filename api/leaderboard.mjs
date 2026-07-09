// PATTY DASH weekly leaderboard. Racers enter as their Solana wallet
// address — the same address a winning airdrop is sent to. Scores live
// in one Redis sorted set per ISO week (lb:2026-W28); ZADD GT keeps
// each racer's best score. Reuses the Upstash setup from api/track.mjs
// and responds 501 until that's configured.

import { createHash } from "crypto";
import { kvEnv, kvPipeline } from "./track.mjs";

// base58 Solana address; "healthcheck" is reserved for the monitor probe
const NAME_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOP_N = 20;
const WEEK_TTL = 60 * 60 * 24 * 40; // keep past weeks around for payouts

export function isoWeek(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // shift to ISO Thursday
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

// score accrues at ≤ ~308/s (top speed 1120 × 0.055 × x5 crowns) plus
// bag pickups — anything past this ceiling is a doctored request
const plausible = (score, t) => score <= 400 + t * 1500;

const toRows = (flat) => {
  const rows = [];
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    rows.push({ name: flat[i], score: Number(flat[i + 1]) || 0 });
  }
  return rows;
};

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const kv = kvEnv();
  if (!kv) return res.status(501).json({ error: "leaderboard not configured" });
  const week = isoWeek();
  const key = "lb:" + week;

  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
      const name = String(body?.name ?? "").trim();
      const score = Math.round(Number(body?.score));
      const t = Number(body?.t);
      if (!NAME_RE.test(name) && name !== "healthcheck") {
        return res.status(400).json({ error: "racer name must be a valid Solana wallet address" });
      }
      if (!Number.isFinite(score) || score < 1 || score > 2_000_000 ||
          !Number.isFinite(t) || t < 1 || t > 3600 || !plausible(score, t)) {
        return res.status(400).json({ error: "score rejected" });
      }

      // humans retry a run every ~10s; 30 posts/min per IP is generous
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const rl = "lbrl:" + createHash("sha256").update(ip + (req.headers["user-agent"] || "")).digest("hex").slice(0, 12);
      const gate = await kvPipeline([["INCR", rl], ["EXPIRE", rl, 60]], kv);
      if (Number(gate[0]?.result) > 30) return res.status(429).json({ error: "slow down, racer" });

      // "healthcheck" is reserved for the monitoring probe: it exercises
      // the same write path against a throwaway key and scrubs itself
      // off the real board instead of appearing on it
      const isProbe = name === "healthcheck";
      const target = isProbe ? "lbtest:" + week : key;
      const out = await kvPipeline([
        ...(isProbe ? [["ZREM", key, name]] : []),
        ["ZADD", target, "GT", score, name],
        ["EXPIRE", target, isProbe ? 3600 : WEEK_TTL],
        ["ZSCORE", target, name],
        ["ZREVRANK", target, name],
        ["ZRANGE", key, 0, TOP_N - 1, "REV", "WITHSCORES"]
      ], kv);
      const o = isProbe ? 1 : 0;
      return res.status(200).json({
        ok: true,
        week,
        best: Number(out[o + 2]?.result) || score,
        rank: (Number(out[o + 3]?.result) || 0) + 1,
        top: toRows(out[o + 4]?.result)
      });
    }

    const out = await kvPipeline([
      ["ZRANGE", key, 0, TOP_N - 1, "REV", "WITHSCORES"]
    ], kv);
    res.setHeader("cache-control", "s-maxage=10");
    return res.status(200).json({ week, top: toRows(out[0]?.result) });
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
