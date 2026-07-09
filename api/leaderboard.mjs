// PATTY DASH weekly leaderboard. Racers pick a username (3-30 chars),
// first come, first served: the browser holds a secret claim token and
// the server stores its hash under lbclaim:<name>, so a different
// browser trying the same name gets a 409. Scores live in one Redis
// sorted set per ISO week (lb:2026-W28); ZADD GT keeps each racer's
// best. Reuses the Upstash setup from api/track.mjs and responds 501
// until that's configured.

import { createHash } from "crypto";
import { kvEnv, kvPipeline } from "./track.mjs";

// "healthcheck" is reserved for the monitor probe
const NAME_RE = /^[A-Za-z0-9 _.\-]{3,30}$/;
const TOP_N = 20;
const WEEK_TTL = 60 * 60 * 24 * 40;  // keep past weeks around for payouts
const CLAIM_TTL = 60 * 60 * 24 * 90; // names free up after 90 quiet days

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
      const isProbe = name === "healthcheck";
      if (!isProbe && !NAME_RE.test(name)) {
        return res.status(400).json({ error: "3-30 characters — letters, numbers, spaces or _ . -" });
      }

      // rate limit + name claim in one round trip. The claim token never
      // leaves the racer's browser; only its hash is stored.
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const rl = "lbrl:" + createHash("sha256").update(ip + (req.headers["user-agent"] || "")).digest("hex").slice(0, 12);
      const cmds = [["INCR", rl], ["EXPIRE", rl, 60]];
      let tokenHash = null, claimKey = null;
      if (!isProbe) {
        const token = String(body?.token ?? "");
        if (token.length < 8 || token.length > 128) {
          return res.status(400).json({ error: "missing claim token — reload the game page" });
        }
        tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 32);
        claimKey = "lbclaim:" + name.toLowerCase();
        cmds.push(["SET", claimKey, tokenHash, "NX", "EX", CLAIM_TTL], ["GET", claimKey]);
      }
      const gate = await kvPipeline(cmds, kv);
      if (Number(gate[0]?.result) > 30) return res.status(429).json({ error: "slow down, racer" });
      if (!isProbe && gate[3]?.result !== tokenHash) {
        return res.status(409).json({ error: "that racer name is taken — pick another" });
      }

      // the start gate pings with {claim: true} to reserve the name
      // before the race — no score involved yet
      if (body?.claim) return res.status(200).json({ ok: true, week, name });

      const score = Math.round(Number(body?.score));
      const t = Number(body?.t);
      if (!Number.isFinite(score) || score < 1 || score > 2_000_000 ||
          !Number.isFinite(t) || t < 1 || t > 3600 || !plausible(score, t)) {
        return res.status(400).json({ error: "score rejected" });
      }

      // the probe exercises the same write path against a throwaway key
      // and scrubs itself off the real board instead of appearing on it;
      // real posts keep the racer's name claim fresh
      const target = isProbe ? "lbtest:" + week : key;
      const out = await kvPipeline([
        isProbe ? ["ZREM", key, name] : ["EXPIRE", claimKey, CLAIM_TTL],
        ["ZADD", target, "GT", score, name],
        ["EXPIRE", target, isProbe ? 3600 : WEEK_TTL],
        ["ZSCORE", target, name],
        ["ZREVRANK", target, name],
        ["ZRANGE", key, 0, TOP_N - 1, "REV", "WITHSCORES"]
      ], kv);
      return res.status(200).json({
        ok: true,
        week,
        best: Number(out[3]?.result) || score,
        rank: (Number(out[4]?.result) || 0) + 1,
        top: toRows(out[5]?.result)
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
