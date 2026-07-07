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

## Deploying (GitHub Pages)

This repo ships with a workflow (`.github/workflows/deploy.yml`) that publishes the site to GitHub Pages on every push to `main` — no configuration needed. The first run enables Pages automatically; after it finishes, the site is live at:

```
https://<your-username>.github.io/patty-prix/
```

You can also trigger a deploy manually from the **Actions** tab (workflow_dispatch). If the first run fails with a Pages permission error, set **Settings → Pages → Source** to "GitHub Actions" once and re-run it.

## Telegram live scoreboard

`.github/workflows/telegram-scoreboard.yml` keeps a pinned message in your Telegram group updated with live race standings (every ~10 minutes). Setup:

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Add the bot to your group and promote it to **admin** with the **Pin messages** right.
3. Get the group's chat ID: send any message in the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`
   (group IDs are negative, e.g. `-1001234567890`).
4. In this repo: **Settings → Secrets and variables → Actions** → add
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
5. Trigger **Telegram Scoreboard** manually from the Actions tab to test.

The bot edits its own pinned message in place; if the pin is missing it posts and pins a fresh one. Without the secrets the workflow exits quietly.

Note: GitHub disables scheduled workflows after ~60 days without repo activity — any commit re-arms them.

Keep the token addresses in `scripts/telegram-scoreboard.mjs` in sync with the `CONFIG` block in `index.html`.

## Notes for Claude Code

- Everything lives in one file (`index.html`) — HTML, CSS, and JS.
- The DexScreener endpoint used is `GET https://api.dexscreener.com/tokens/v1/solana/{addr1},{addr2},...` (up to 30 addresses per call, all tokens fetched in a single request).
- Market cap uses `pair.marketCap` with `pair.fdv` as fallback; the most liquid pair per token is selected.
