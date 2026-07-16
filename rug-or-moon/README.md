# Rug or Moon 🚩🌙

A **Solana token safety + alpha scanner** PWA for the Seeker dApp Store. Paste a
token address → get a heuristic **safety score** (mint/freeze authority, holder
concentration, liquidity, age, wash-trading smell) plus **alpha signals** (smart
money holding, buy/sell momentum) — the 5-second "should I ape this?" check.

> Heuristics from public on-chain data, **not financial advice** and not a
> guarantee. A high score isn't a green light; a low score isn't proof of a
> scam. The UI says so on every result.

## Features

- **Scan** — paste a token → safety score + red flags + smart-money/momentum alpha.
- **🔥 Trending** — opens to today's trending tokens, auto-scanned and sorted
  gems-up / rugs-down, so you get a ready-made board instead of a blank box.
- **👀 Watchlist + alerts** — save tokens; the app re-scans them and flags when
  **safety drops** (≥20 pts), a **tier downgrades**, **smart money exits**, or a
  **new red flag** appears — firing a local notification. Free plan watches up to
  5 tokens (premium unlimited is a planned auth+payment step).

## How it's built

- **`index.html`** — the PWA (single file, no build step, dark mobile-first UI)
  with Scan / Trending / Watchlist tabs. Installable; supports deep links
  (`/?token=…` scans on load — great for sharing "scan this before you buy").
  The watchlist lives in `localStorage`; alerts use the browser Notifications API.
- **`api/scan.mjs`** — Vercel serverless endpoint. Gathers DexScreener (keyless
  market data) + Solana RPC via Helius (mint authorities + top holders,
  server-side so the key never reaches the client) and returns a scored result.
- **`api/trending.mjs`** — gathers today's trending mints (Birdeye if
  `BIRDEYE_API_KEY` is set, else DexScreener's keyless boosted list) and runs each
  through the same `scanToken()` pipeline, returning a gems→rugs board.
- **`scoring.mjs`** — the pure, tested scoring engine (shared by the API + tests).
- **`watchlist.mjs`** — the pure, tested diff/alert + freemium logic (what counts
  as an alert-worthy change between two scans). The UI mirrors it client-side.
- **`smart-money.mjs`** — loads + matches the known smart-money wallet set.
- **`manifest.json` / `sw.js`** — PWA manifest + service worker (installability,
  offline shell) — the requirements for the Seeker TWA wrap.

## Run / deploy

```bash
npm test                 # scoring + API-layer tests (offline, mocked data)
```

Deploy as its own **Vercel** project (root = `rug-or-moon/`):

- Set env var **`HELIUS_API_KEY`** (Settings → Environment Variables) — powers the
  authority + holder checks. Without it the app still runs on market data only
  and says so.
- Optional **`BIRDEYE_API_KEY`** — improves the Trending board's source list. Not
  set? Trending falls back to DexScreener's keyless boosted list automatically.
- **Smart-money alpha (the differentiator):** provide a wallet list so the scanner
  flags when known smart money holds a token. Either commit a `smart-money.json`
  (copy `smart-money.sample.json`) or set `SMART_MONEY_JSON` to inline JSON. The
  Patty Prix whale tracker produces this directly: `node scripts/whale-tracker.mjs
  --json > rug-or-moon/smart-money.json`. Without a list, alpha uses momentum only.
- Static files + the `api/` function deploy automatically (same convention as the
  main patty-prix site).

## Monetization hooks (built in)

1. **SKR developer grant** — shipping a quality app to the dApp Store has been
   rewarded directly (Season 1: 750k SKR each to 188 devs). Zero store fees.
2. **Jupiter referral** — the "Buy on Jupiter" button routes swaps to Jupiter.
   Set `JUP_REFERRAL` in `index.html` to your referral params to earn a fee on
   every swap the app sends.
3. **Freemium** — the watchlist + alerts layer is built: free users watch up to 5
   tokens with safety-drop / smart-money-exit alerts; the upsell is unlimited
   watching + push alerts. The limit is enforced client-side today — turning it
   into paid unlock still needs **auth + payment** (the one owner step here).

Honest ceiling: ~150k Seeker devices is niche scale — treat this as "ship a sharp
useful app, plausibly earn a grant + modest referral revenue," not a unicorn.

## Publish to the Seeker dApp Store (owner steps)

The store takes a signed Android APK; a PWA is wrapped as a **Trusted Web
Activity**. See <https://docs.solanamobile.com/dapp-store/publishing-a-web-app>.

1. **PNG icons** the manifest references (`icons/icon-192.png`, `icon-512.png`,
   `icon-512-maskable.png`) are generated and committed — rendered from
   `icon.svg` via `node scripts/render-icons.mjs` (re-run it if you change the
   SVG). The maskable variant is full-bleed with the shield inside the safe zone.
2. **Wrap the PWA** with Bubblewrap (`@bubblewrap/cli`) against your deployed URL
   + `manifest.json` → a signed release APK.
3. **Publish** with the dApp Store CLI (`@solana-mobile/dapp-store-cli`): mint the
   Publisher, App, and Release NFTs (your keypair + a little SOL), then submit;
   review is ~3–5 business days.
4. Provide listing assets (icon, screenshots, description) and a **privacy
   policy** URL. The policy is built: `privacy.html` deploys at
   `https://your-app/privacy.html` (linked from the app footer). Fill in the
   `REPLACE_WITH_YOUR_CONTACT_EMAIL` placeholder before you submit.

## What's verified vs. yours

- ✅ **Tested here:** the scoring engine, the scan + trending gather layers, and
  the watchlist diff/alert + freemium logic (offline, mocked data), plus a
  headless-browser smoke-test that drives all three tabs, the watch button,
  localStorage persistence, and the trending board.
- 👤 **Yours:** deploy + set `HELIUS_API_KEY` (and optional `BIRDEYE_API_KEY`),
  set the Jupiter referral, add auth+payment to unlock premium watching, wrap +
  sign the APK, and mint the store NFTs.
