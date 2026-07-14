// Read side for the Print Shop dashboard: prints today, all-time, a
// 14-day history, remaining daily budget and an estimated spend. Reads
// the same gp:* counters api/generate.mjs writes. No secrets exposed —
// just counts.

const GLOBAL_PER_DAY = Number(process.env.PRINT_GLOBAL || 100);
const PER_VISITOR_PER_DAY = Number(process.env.PRINT_PER_VISITOR || 5);
const COST = Number(process.env.PRINT_COST || 0.134); // ~$/image, Nano Banana Pro

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

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  const kv = kvEnv();
  if (!kv) return res.status(501).json({ error: "print stats need the KV store" });

  const days = [];
  const now = Date.now();
  for (let i = 13; i >= 0; i--) days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  const today = days[days.length - 1];

  try {
    const out = await kvPipeline([
      ["GET", "gp:alltime"],
      ["MGET", ...days.map(d => "gp:total:" + d)]
    ], kv);
    const alltime = Number(out[0]?.result) || 0;
    const series = (out[1]?.result || []).map(v => Number(v) || 0);
    const todayCount = series[series.length - 1] || 0;
    res.setHeader("cache-control", "s-maxage=20");
    return res.status(200).json({
      today: todayCount,
      alltime,
      remainingToday: Math.max(0, GLOBAL_PER_DAY - todayCount),
      globalCap: GLOBAL_PER_DAY,
      perVisitorCap: PER_VISITOR_PER_DAY,
      costPerImage: COST,
      spendToday: +(todayCount * COST).toFixed(2),
      spendAllTime: +(alltime * COST).toFixed(2),
      days: days.map((d, i) => ({ day: d, prints: series[i] || 0 }))
    });
  } catch (err) {
    return res.status(502).json({ error: String(err && err.message || err) });
  }
}
