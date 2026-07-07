// Vercel serverless proxy for Helius — keeps the API key server-side.
// The key lives in the HELIUS_API_KEY environment variable (Vercel
// project → Settings → Environment Variables), never in the page.
//
// Locked to this project's mint + airdrop wallet so the endpoint can't
// be used to query arbitrary data on our key:
//   GET /api/stats?q=holders&page=N   → Helius getTokenAccounts (our mint)
//   GET /api/stats?q=supply           → Helius getTokenSupply (our mint)
//   GET /api/stats?q=airdrop[&before=SIG] → airdrop wallet's transactions

const MINT = "2jz9E5JrEbxLg1RhU68aaSikDvpQurCEZz9BBF9rpump";
const AIRDROP_WALLET = "8CFVLmzq8Uo6N859y2qFUumrzP291VceztiEperzv941";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{20,100}$/;

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  const key = process.env.HELIUS_API_KEY;
  if (!key) return res.status(500).json({ error: "HELIUS_API_KEY not configured" });

  const rpc = async (method, params) => {
    const r = await fetch("https://mainnet.helius-rpc.com/?api-key=" + key, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    return r.json();
  };

  const { q, page, before } = req.query;
  try {
    if (q === "holders") {
      const p = Math.max(1, Math.min(100, parseInt(page, 10) || 1));
      const data = await rpc("getTokenAccounts", { mint: MINT, limit: 1000, page: p });
      res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=600");
      return res.status(200).json(data);
    }
    if (q === "supply") {
      const data = await rpc("getTokenSupply", [MINT]);
      res.setHeader("cache-control", "s-maxage=600, stale-while-revalidate=3600");
      return res.status(200).json(data);
    }
    if (q === "airdrop") {
      if (before && !BASE58.test(before)) return res.status(400).json({ error: "bad cursor" });
      const url = "https://api.helius.xyz/v0/addresses/" + AIRDROP_WALLET +
        "/transactions?api-key=" + key + "&limit=100" +
        (before ? "&before=" + before : "");
      const r = await fetch(url);
      res.setHeader("cache-control", "s-maxage=300, stale-while-revalidate=1800");
      return res.status(200).json(await r.json());
    }
    return res.status(400).json({ error: "unknown q" });
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
}
