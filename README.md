# Patty Prix 🏁

*pattyice — the bag worker — races the field.*

A live race page comparing pattyice's market cap against a set of rival Solana tokens. The challenger token's icon is the "race car" that moves along each track in real time as prices update.

## Setup (2 steps)

1. Open `index.html` and find the `CONFIG` block at the top of the `<script>` section.
2. Paste in your token addresses:
   - `challenger`: the contract address of your main token (the racer)
   - `rivals`: an array of contract addresses for the tokens it's racing to flip (add as many as you want)

That's it. No API keys, no build step, no backend.

## How it works

- Prices come from the free DexScreener API (`api.dexscreener.com`), polled every 10 seconds (configurable via `pollIntervalMs`).
- Token names, symbols, and icons are pulled automatically from DexScreener — the challenger's icon becomes the race car, each rival's icon sits at the finish line.
- Progress = challenger market cap ÷ rival market cap. The purple pill shows the multiple still needed ("146x to go").
- Cards auto-sort so the closest flip is always on top.
- If a race hits 100%, the card turns gold and shows "FLIPPED 👑".
- Status messages change by progress tier (marathon jokes at <1%, training montage at 10%+, etc.) — edit `statusLine()` to customize the copy.

## Running it

Just open `index.html` in a browser, or serve it locally:

```bash
npx serve .
# or
python3 -m http.server
```

Deploys anywhere static files work: Vercel, Netlify, GitHub Pages, Cloudflare Pages.

## Notes for Claude Code

- Everything lives in one file (`index.html`) — HTML, CSS, and JS.
- The DexScreener endpoint used is `GET https://api.dexscreener.com/tokens/v1/solana/{addr1},{addr2},...` (up to 30 addresses per call, all tokens fetched in a single request).
- Market cap uses `pair.marketCap` with `pair.fdv` as fallback; the most liquid pair per token is selected.
