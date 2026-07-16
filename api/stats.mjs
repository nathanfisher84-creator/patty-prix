// Vercel serverless proxy for Helius — keeps the API key server-side.
// The key lives in the HELIUS_API_KEY environment variable (Vercel
// project → Settings → Environment Variables), never in the page.
//
// Locked to this project's mint + airdrop wallet so the endpoint can't
// be used to query arbitrary data on our key:
//   GET /api/stats?q=holders&page=N   → Helius getTokenAccounts (our mint)
//   GET /api/stats?q=supply           → Helius getTokenSupply (our mint)
//   GET /api/stats?q=airdrop[&before=SIG] → airdrop wallet's transactions

const MINT = "98UYfFK6VFNTpv2Hp7NYy4yLdzvCfcpv69TuJgYdpump";
const AIRDROP_WALLET = "8CFVLmzq8Uo6N859y2qFUumrzP291VceztiEperzv941";
// Keep in sync with CONFIG.rivals in index.html — the holderCount
// endpoint only answers for these tokens.
const RIVALS = [
  "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
  "6baGyq4HLbUn93MQUGFqBktpXP8BRjpoxSsAap4ppump",
  "CFPkPq1eYPR8GLzEo59wUbbMioX4bshaTQiSGzTSpump",
  "5pYB12kEhfhSFXJjZ7JtyqDpt6uUqhsF6iu6Ee9spump",
  "DdPrHYqM8Ueovnk9kAnAgoGhswkuaTqmxcoZzU3Zpump",
  "4U4U8oXwDyVXGeTffMXds4NAgBgLFwq3wNvTCRTSpump",
  "9E2Q4KKxLS5Y4bu6RKvjg5wQ2kzaLkiVsMt7zwMZpump",
  "a3W4qutoEJA4232T2gwZUfgYJTetr96pU4SJMwppump",
  "BWH6gtE5MSCS1GUoRpM5HrqQnV97oi8g8dDHAi41pump"
];
const TRACKED = new Set([MINT, ...RIVALS]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{20,100}$/;

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  const heliusKey = process.env.HELIUS_API_KEY;
  const noHelius = () => res.status(500).json({ error: "HELIUS_API_KEY not configured" });

  const rpc = async (method, params) => {
    const r = await fetch("https://mainnet.helius-rpc.com/?api-key=" + heliusKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    return r.json();
  };

  const { q, page, before } = req.query;
  try {
    if (q === "holders") {
      if (!heliusKey) return noHelius();
      const p = Math.max(1, Math.min(100, parseInt(page, 10) || 1));
      const data = await rpc("getTokenAccounts", { mint: MINT, limit: 1000, page: p });
      res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=600");
      return res.status(200).json(data);
    }
    if (q === "supply") {
      if (!heliusKey) return noHelius();
      const data = await rpc("getTokenSupply", [MINT]);
      res.setHeader("cache-control", "s-maxage=600, stale-while-revalidate=3600");
      return res.status(200).json(data);
    }
    if (q === "airdrop") {
      if (!heliusKey) return noHelius();
      if (before && !BASE58.test(before)) return res.status(400).json({ error: "bad cursor" });
      const url = "https://api.helius.xyz/v0/addresses/" + AIRDROP_WALLET +
        "/transactions?api-key=" + heliusKey + "&limit=100" +
        (before ? "&before=" + before : "");
      const r = await fetch(url);
      res.setHeader("cache-control", "s-maxage=300, stale-while-revalidate=1800");
      return res.status(200).json(await r.json());
    }
    if (q === "holderCount") {
      // holder count for any tracked token, via Birdeye token_overview
      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      if (!birdeyeKey) return res.status(500).json({ error: "BIRDEYE_API_KEY not configured" });
      const t = req.query.token;
      if (!TRACKED.has(t)) return res.status(400).json({ error: "untracked token" });
      const r = await fetch("https://public-api.birdeye.so/defi/token_overview?address=" + t, {
        headers: { "X-API-KEY": birdeyeKey, "x-chain": "solana", accept: "application/json" }
      });
      const data = await r.json();
      const holders = data?.data?.holder ?? data?.data?.holders ?? null;
      if (holders == null) return res.status(502).json({ error: "no holder data" });
      res.setHeader("cache-control", "s-maxage=600, stale-while-revalidate=3600");
      return res.status(200).json({ holders: Number(holders) });
    }
    if (q === "ath") {
      // True token-level all-time high via Birdeye (daily candles across
      // all pools); the client falls back to GeckoTerminal pool history
      // if this endpoint errors.
      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      if (!birdeyeKey) return res.status(500).json({ error: "BIRDEYE_API_KEY not configured" });
      const bird = async (path) => {
        const r = await fetch("https://public-api.birdeye.so" + path, {
          headers: { "X-API-KEY": birdeyeKey, "x-chain": "solana", accept: "application/json" }
        });
        return r.json();
      };
      const now = Math.floor(Date.now() / 1000);
      const from = now - 400 * 86400;
      let athPrice = 0, athTime = 0;
      const ohlcv = await bird(`/defi/ohlcv?address=${MINT}&type=1D&time_from=${from}&time_to=${now}`);
      for (const c of ohlcv?.data?.items || []) {
        if (c.h > athPrice) { athPrice = c.h; athTime = c.unixTime; }
      }
      if (!athPrice) {
        // some plans expose history_price but not ohlcv
        const hist = await bird(`/defi/history_price?address=${MINT}&address_type=token&type=1D&time_from=${from}&time_to=${now}`);
        for (const p of hist?.data?.items || []) {
          if (p.value > athPrice) { athPrice = p.value; athTime = p.unixTime; }
        }
      }
      if (!athPrice) return res.status(502).json({ error: "no price history" });
      res.setHeader("cache-control", "s-maxage=1800, stale-while-revalidate=86400");
      return res.status(200).json({ athPrice, athTime });
    }
    return res.status(400).json({ error: "unknown q" });
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
