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

## Paper-trading MEV bot 🥷

`scripts/mev-paper-bot.mjs` is an educational, **paper-only** cross-DEX arbitrage bot — no wallet, no keys, no real transactions, ever. It scans DexScreener for Solana tokens that trade in multiple pools (Raydium, Orca, Meteora, …), spots price spreads between pools, and simulates buying the cheap pool / selling the expensive one.

```bash
node scripts/mev-paper-bot.mjs            # run forever (Ctrl-C prints P&L)
node scripts/mev-paper-bot.mjs --stats    # show the paper ledger summary
node scripts/mev-paper-bot.mjs --reset    # wipe the ledger and start over
```

The simulation is deliberately pessimistic, because that's the lesson:

- **Latency** — an opportunity spotted this poll is filled at *next* poll's prices. Public-API bots are seconds behind; watch the "latency ate X% of edge" lines.
- **Fees** — both swap legs pay the pool fee, and every attempt pays a priority-fee/tip (default $0.15) even when it fails.
- **Price impact** — your own trade moves thin pools against you (constant-product estimate).
- **Racing** — a configurable land rate (default 60%) decides whether a faster bot beat you. Lose the race → pay the tip, get nothing.

Tune with `--size <usd>`, `--min-edge <pct>`, `--land-rate <pct>`, `--interval <ms>`, and `--tokens <mint,mint,…>`. The default scan list is a handful of liquid multi-pool tokens (BONK, WIF, JUP, RAY, POPCAT) — fresh pump.fun tokens usually live in a single PumpSwap pool, so there's nothing to arb there. Trades are logged to `scripts/paper-ledger.json` (gitignored).

Expected result after a few hours: **negative P&L**. That's not a bug — it's an honest demo of why real MEV needs co-located infrastructure, not a polling loop.

## Sandwich simulator 🥪

`scripts/sandwich-simulator.mjs` is a **paper-only calculator** for the predatory side of MEV — the "subway never closes" sandwich attack. It's a self-contained AMM model, not a bot: it never touches a mempool, RPC, wallet, or chain, and there's deliberately no transaction-submission code anywhere in it. You describe a hypothetical victim swap and it computes what a sandwich would do to it.

```bash
node scripts/sandwich-simulator.mjs                    # default ETH-style example
node scripts/sandwich-simulator.mjs --chain solana     # Solana fee/tip preset
node scripts/sandwich-simulator.mjs --sweep            # slippage sensitivity table
node scripts/sandwich-simulator.mjs --victim 8000 --slippage 3 --land-rate 25
```

It uses constant-product (Uniswap-v2 / Raydium-style) math to find the attacker's optimal frontrun size, then reports the three numbers the hype threads leave out:

- **Who pays** — the victim's overpayment *is* the attacker's gross profit. It's a transfer, not "tightened spreads."
- **The revert wall** — if the frontrun pushes price past the victim's slippage tolerance, the victim's tx reverts and the attack fails. Tighter slippage starves the attack; the `--sweep` table shows exactly how.
- **Rent every attempt** — a lost race still costs gas/tip. The simulator prints the break-even land rate and the expected value per attempt, which goes negative once your win rate drops against better-funded searchers.

Options: `--chain <eth|solana>`, `--liq <usd>`, `--victim <usd>`, `--slippage <pct>`, `--fee <pct>`, `--gas <usd>`, `--land-rate <pct>`.

## Smart-money / whale tracker 🐋

`scripts/whale-tracker.mjs` discovers Solana whale wallets you *don't* already know and ranks them by how good their trading actually is — realized PnL and win rate, not just position size — then shows what they're currently buying. It's pure public on-chain analysis (pseudonymous wallets and their swaps); it does not attempt to identify the people behind wallets.

Pipeline: Birdeye **trending tokens** → top holders of each (Helius) as whale suspects → score each suspect's swap history into **realized PnL + win rate** (average-cost basis) → surface the smart-money wallets and their recent buys.

```bash
node scripts/whale-tracker.mjs                                  # full run, defaults
node scripts/whale-tracker.mjs --trending 15 --candidates 40 --limit 20
node scripts/whale-tracker.mjs --min-pnl 10000 --min-winrate 55 --min-trades 8 --json
```

It reuses the two keys `api/stats.mjs` already needs, read from the environment:

```bash
HELIUS_API_KEY=…  BIRDEYE_API_KEY=…  node scripts/whale-tracker.mjs
```

Filters: `--trending`, `--per-token`, `--candidates`, `--swap-pages` (how much history to score), `--min-pnl`, `--min-winrate`, `--min-trades`, `--limit`, `--sol-price`, `--json`. PnL is reconstructed in USD via the SOL/stablecoin legs of each swap (token↔token swaps are skipped since they can't be priced from the trade alone), so treat the numbers as a strong heuristic, not audited accounting.

**Where it runs:** anywhere it can reach `mainnet.helius-rpc.com` and Birdeye — your machine or Vercel. It will *not* run in a network-restricted sandbox. Be mindful of API rate limits: scoring N candidates costs roughly N × `--swap-pages` Helius calls, so raise `--candidates` gradually.

### Telegram whale alerts

`scripts/whale-alerts.mjs` + `.github/workflows/whale-alerts.yml` turn the tracker into a live feed: it watches a list of wallets and posts to your Telegram group whenever one makes a fresh buy (token, USD size, time, solscan links). It's **two-phase** so the cron stays cheap:

1. **Discovery (occasional)** — run the tracker to build the watchlist:
   ```bash
   node scripts/whale-tracker.mjs --json > scripts/whale-watchlist.json
   ```
   The watchlist is any JSON array of addresses or `{ "wallet": "...", "label": "..." }` objects (see `whale-watchlist.example.json`). Commit it. Re-run when you want to refresh who's tracked.
2. **Alerts (every 15 min)** — the workflow polls that watchlist and posts new buys:
   ```bash
   node scripts/whale-alerts.mjs --lookback 15 --min-usd 500
   ```

Setup: reuse the `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` secrets from the scoreboard bot, and the `HELIUS_API_KEY` (required) / `BIRDEYE_API_KEY` (optional, for SOL pricing) secrets from the stats API. Without a committed watchlist or the secrets, the workflow logs a hint and exits quietly.

Dedup is time-windowed: keep `--lookback` equal to the cron interval so each buy alerts once. A delayed run can rarely repeat or miss one — the deliberate tradeoff for staying database-free, same as the scoreboard. Options: `--file`, `--lookback`, `--min-usd`, `--sol-price`.

## Daily research newsletter 📰

`scripts/research-agent.mjs` + `.github/workflows/research-newsletter.yml` build and post a **daily Solana briefing** to Telegram. It's the capstone that ties the other tools together into one edition:

- 🎯 **Where smart money is going** — the headline: tokens that *multiple* tracked whales are buying (consensus), not just one big trade
- 🐋 **Smart money** — the top-ranked wallets by realized PnL / win rate (from the whale tracker)
- 🔥 **Trending**, 📈 **biggest gainers**, 📉 **biggest losers** (Birdeye)
- a written intro via a **provider ladder — Gemini → Claude → deterministic template** — so the agent runs with whichever LLM key you have, or none

```bash
node scripts/research-agent.mjs --dry            # build + print, don't post
node scripts/research-agent.mjs --out today.md   # also write the Markdown edition
node scripts/research-agent.mjs                   # build + post to Telegram
```

Setup reuses everything you already have: `HELIUS_API_KEY` + `BIRDEYE_API_KEY` (stats API) and `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (scoreboard bot). For the written intro, add **one** of:

- `GEMINI_API_KEY` — preferred; model defaults to `gemini-2.5-flash-lite` (the cheapest tier, ~$0.10/$0.40 per 1M tokens), override with `GEMINI_MODEL` (e.g. `gemini-3.1-flash-lite` for the newer budget model).
- `ANTHROPIC_API_KEY` — used only if no Gemini key; model defaults to `claude-sonnet-5`, override with `ANTHROPIC_MODEL`.

With neither, the deterministic template writes the intro. Both LLM calls use plain `fetch` — no SDK, keeping the repo dependency-free — and disable "thinking" so the whole 400-token budget goes to the prose. The workflow runs daily at 13:00 UTC; without the required secrets it logs a hint and exits quietly.

Options: `--dry`, `--out <file>`, `--trending <n>`, `--candidates <n>`, `--min-pnl <usd>`, `--min-winrate <pct>`, `--min-trades <n>`, `--consensus <n>` (min whales for consensus), `--top <n>` (rows per section).

## Notes for Claude Code

- Everything lives in one file (`index.html`) — HTML, CSS, and JS.
- The DexScreener endpoint used is `GET https://api.dexscreener.com/token-pairs/v1/solana/{address}` (one request per token, fetched in parallel — it returns ALL of a token's pools; the batch `/tokens/v1/` endpoint returns a single pair per token and can pick a stale graduated bonding-curve listing).
- Market cap uses `pair.marketCap` with `pair.fdv` as fallback; PumpSwap pools are preferred (most liquid one if several), otherwise the most liquid pool on any DEX.

## Hosting

The site deploys to GitHub Pages (workflow above) and is also connected to Vercel, which auto-deploys every push to `main` and creates preview deployments for pull requests. The canonical home is **https://pattyprix.xyz** (custom domain on the Vercel project; DNS at Namecheap — A `@` → `76.76.21.21`, CNAME `www` → `cname.vercel-dns.com`).

## Stats API (Helius proxy)

`api/stats.mjs` is a Vercel serverless function that proxies Helius for the HOLDERS tile and The Airdrop Fam section, keeping the API key out of the public page. It is locked to this project's mint and airdrop wallet.

Setup: Vercel project → **Settings → Environment Variables** → add `HELIUS_API_KEY` and `BIRDEYE_API_KEY` (all environments) → redeploy. Helius powers holders + airdrop data; Birdeye powers the true token-level all-time high (`?q=ath`), with GeckoTerminal pool history as the client-side fallback. Both the Vercel and GitHub Pages deployments call the same `https://patty-prix.vercel.app/api/stats` endpoint (`CONFIG.statsApi` in `index.html`). Responses are edge-cached (2–10 min) to stay inside Helius free-tier limits.
