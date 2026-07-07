// Read side of the self-owned visit counter (see api/track.mjs):
// returns total views, today's views + approximate uniques, and a
// 14-day daily series for the dashboard's chart.

import { kvEnv, kvPipeline } from "./track.mjs";

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  const kv = kvEnv();
  if (!kv) return res.status(501).json({ error: "visit tracking not configured" });

  const days = [];
  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  }
  const today = days[days.length - 1];

  try {
    const out = await kvPipeline([
      ["GET", "pv:total"],
      ["MGET", ...days.map(d => "pv:" + d)],
      ["PFCOUNT", "uv:" + today]
    ], kv);
    const [total, series, uniques] = out.map(o => o && o.result);
    res.setHeader("cache-control", "s-maxage=30");
    return res.status(200).json({
      total: Number(total) || 0,
      today: { views: Number(series?.[series.length - 1]) || 0, uniques: Number(uniques) || 0 },
      days: days.map((d, i) => ({ day: d, views: Number(series?.[i]) || 0 }))
    });
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
