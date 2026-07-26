# Live liquidity-watch Telegram bot — setup (beginner walkthrough)

An always-on bot that watches your Solana tokens and DMs you the moment liquidity
starts draining (plus safety drops, smart-money exits, and the "cut supply on the
pump" pattern). **Monitor-only — it never touches your keys or funds.**

The code is `scripts/liquidity-bot.mjs`. It reuses the tested Rug or Moon engine.
You just need to (1) make a Telegram bot, (2) find your chat id, (3) host it.

---

## Step 1 — Create your Telegram bot (2 min)

1. Open Telegram and search for **@BotFather** (the one with the blue check).
2. Send **`/newbot`**.
3. Give it a **name** (e.g. "My Rug Watcher") and a **username** ending in `bot`
   (e.g. `myrugwatch_bot`).
4. BotFather replies with a **token** that looks like `8123456789:AAE...long...`.
   **Copy it** — that's your `TELEGRAM_BOT_TOKEN`.

## Step 2 — Find your chat id (1 min)

1. In Telegram, search for **@userinfobot** and open it.
2. Send it **any message** (e.g. "hi").
3. It replies with your **Id** (a number like `123456789`). **Copy it** — that's
   your `TELEGRAM_CHAT_ID`. (The bot only obeys this id, so no one else can control it.)
4. Now open **your new bot** (the username from Step 1) and tap **Start**, so it's
   allowed to message you.

## Step 3 — Host it so it's live 24/7 (Railway, ~$5/mo)

Railway is the most beginner-friendly always-on host.

1. Go to **[railway.app](https://railway.app)** and sign up with **GitHub**.
2. Click **New Project → Deploy from GitHub repo** and pick **patty-prix**.
3. Railway detects the **Dockerfile** in the repo and builds the bot automatically
   (no settings to change).
4. Open the service → **Variables** tab → add these (from Steps 1–2):

   | Variable | Value |
   |----------|-------|
   | `TELEGRAM_BOT_TOKEN` | *(from BotFather)* |
   | `TELEGRAM_CHAT_ID` | *(your id)* |
   | `HELIUS_API_KEY` | *(the same key your website uses)* |
   | `WATCH_TOKENS` | *(optional)* comma-separated mints to watch on startup |
   | `POLL_SECONDS` | *(optional)* how often to check, default `60` |
   | `LIQ_DROP_PCT` | *(optional)* liquidity-drop alert threshold %, default `15` |
   | `VOL_DROP_PCT` | *(optional)* volume-fade threshold %, default `40` |
   | `HOLDER_DROP_PCT` | *(optional)* holders-leaving threshold %, default `10` |
   | `BASELINE_MINUTES` | *(optional)* window for slow trends, default `30` |
   | `COOLDOWN_MINUTES` | *(optional)* min gap between repeat alerts, default `30` |
   | `SMART_MONEY_JSON` | *(optional)* inline JSON of whale wallets that survives redeploys |
   | `DIGEST_HOUR_UTC` | *(optional)* hour (UTC) for the daily digest, default `13` |

5. Railway redeploys. Within a minute your bot messages you: **"🧅 Liquidity
   watcher online."** You're live.

*(Alternatives: [Render](https://render.com) "Background Worker" or
[Fly.io](https://fly.io) work the same way — both use the Dockerfile. Any of them
keeps it running 24/7.)*

## Step 4 — Use it (from Telegram)

- **`/watch <mint>`** — start watching a token (paste its address)
- **`/unwatch <mint>`** — stop watching
- **`/list`** — show what you're watching
- **`/scan <mint>`** — full scan: safety, **top-holder breakdown**, **deployer**
  (with a warning if the deployer still holds a bag), **+ an entry read** (NFA)
- **`/entry <mint>`** — just the entry read (NFA)
- **`/trending`** — today's trending tokens, auto-scanned, safest first
- **`/alert <mint> <pct>`** — ping on a ±% price move (e.g. `/alert <mint> 20`); `off` to clear
- **`/addwhale <wallet> [label]`** — track a smart-money wallet
- **`/discoverwhales`** — auto-find profitable wallets (scans trending tokens →
  their top holders → scores each wallet's PnL) and start tracking them
- **`/whales` · `/delwhale <wallet>`** — list / remove tracked wallets
- **`/flagwallet <wallet> [label]`** — warn me if this wallet holds a token I scan
- **`/flagged` · `/unflagwallet <wallet>`** — list / remove flagged wallets
- **`/mute` · `/unmute`** — pause / resume automatic alerts
- **`/help`** — the command list

**Smart-money wallets:** once you `/addwhale` some wallets, every scan flags tokens
those wallets hold ("🧠 tracked smart-money wallets holding …") and it feeds the
entry read. Like the watchlist, `/addwhale` saves to a file that resets on
redeploy — for permanent whales set the **`SMART_MONEY_JSON`** env variable to an
inline JSON array, e.g. `[{"wallet":"…","label":"Cupsey"}]` (or just `["addr1","addr2"]`).

**Flagged wallets (the inverse list):** `/flagwallet <wallet> [label]` marks a
wallet you want to be *warned* about — a known rugger, an insider, a dev wallet.
Any token you scan that it holds shows a **red "Flagged wallet holding this
token"** line, and if it *buys into* a token you're already watching you get an
alert. Set **`FLAGGED_WALLETS_JSON`** (same inline-JSON format) to keep flagged
wallets across redeploys. Note: flagged wallets warn you but deliberately do
**not** change the safety score — the score stays a statement about on-chain
facts, not about who happens to hold.

**Auto-discovery:** `/discoverwhales` finds them for you — it scans trending
tokens, takes their top holders, reconstructs each wallet's PnL from swap history,
and tracks the ones that clear the bar (≥$5k realized, ≥50% win rate, ≥5 trades).
It's RPC-heavy, so it's rate-limited to once an hour (`DISCOVER_COOLDOWN_MINUTES`)
and runs a lighter scan than the CLI. To keep discovered wallets permanently, run
`/whales` and copy them into `SMART_MONEY_JSON`. Past PnL ≠ future results (NFA).

**Automatic alerts** (per watched token): liquidity draining, the cut-supply-on-
pump pattern, **volume fading**, **holders leaving**, safety dropping, smart money
exiting — plus the positive side: **"setup improving"** (LP just locked, holders
growing fast, safety upgraded). Once a day you also get a **portfolio digest**.
Everything is defensive/NFA — the bot never fires "buy now" signals.

It baselines each token on the first check, then pings you whenever **liquidity
drops** ≥`LIQ_DROP_PCT`%, a **pump drains** the pool, **volume fades**, **holders
leave**, safety falls, or smart money exits — with a per-token cooldown so a slow
drain doesn't ping every minute.

**The entry read** (on `/scan` and `/entry`) is a hedged, structure-based verdict
— 🟢 constructive / 🟡 mixed / 🔴 poor — from safety, liquidity trend, holder
trend, volume, LP-lock, smart money, and whether it's *already pumping* (top
risk). It is **NFA** and never a buy signal — it reads the *risk of entering now*,
not the future price. A safety scanner can't predict price; it can only tell you
when the setup looks healthier vs. frothier.

---

## Honest notes

- **Liveness:** checks every `POLL_SECONDS` (default 60s) continuously — genuinely
  always-on, unlike a cron. Restarting the host re-baselines (no alerts on the
  first pass after a restart).
- **Watchlist persistence:** `/watch` saves to a file in the container. On hosts
  with an ephemeral disk, a redeploy resets it to whatever `WATCH_TOKENS` holds —
  so put tokens you always want in `WATCH_TOKENS`, or attach a Railway/Fly volume.
- **Verification:** the bot's logic is unit-tested (`scripts/liquidity-bot.test.mjs`),
  but the sandbox that built it can't reach Telegram or the token APIs — so the
  **first real run is also the live test.** If an alert looks wrong, tell me the
  token and what it said and I'll fix the parsing. This run also doubles as the
  live sanity-check for the RugCheck/GoPlus/Meteora integrations.
- **Monitor-only:** it does not and will not place trades.
