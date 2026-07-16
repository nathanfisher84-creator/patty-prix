# Rug or Moon 🚩🌙

A **Solana token safety + alpha scanner** PWA for the Seeker dApp Store. Paste a
token address → get a heuristic **safety score** (mint/freeze authority, holder
concentration, liquidity, age, wash-trading smell) plus **alpha signals** (smart
money holding, buy/sell momentum) — the 5-second "should I ape this?" check.

> Heuristics from public on-chain data, **not financial advice** and not a
> guarantee. A high score isn't a green light; a low score isn't proof of a
> scam. The UI says so on every result.

## How it's built

- **`index.html`** — the PWA (single file, no build step, dark mobile-first UI).
  Installable; supports deep links (`/?token=…` scans on load — great for
  sharing "scan this before you buy").
- **`api/scan.mjs`** — Vercel serverless endpoint. Gathers DexScreener (keyless
  market data) + Solana RPC via Helius (mint authorities + top holders,
  server-side so the key never reaches the client) and returns a scored result.
- **`scoring.mjs`** — the pure, tested scoring engine (shared by the API + tests).
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
3. **Freemium (future)** — the natural upsell is unlimited scans + a watchlist
   with alerts when a held token's safety changes or smart money moves. Left as a
   follow-up (needs auth + payment).

Honest ceiling: ~150k Seeker devices is niche scale — treat this as "ship a sharp
useful app, plausibly earn a grant + modest referral revenue," not a unicorn.

## Publish to the Seeker dApp Store (owner steps)

The store takes a signed Android APK; a PWA is wrapped as a **Trusted Web
Activity**. See <https://docs.solanamobile.com/dapp-store/publishing-a-web-app>.

1. **Add PNG icons** the manifest references: `icons/icon-192.png`,
   `icon-512.png`, `icon-512-maskable.png` (render them from `icon.svg`). The SVG
   alone installs, but bubblewrap/TWA wants PNGs.
2. **Wrap the PWA** with Bubblewrap (`@bubblewrap/cli`) against your deployed URL
   + `manifest.json` → a signed release APK.
3. **Publish** with the dApp Store CLI (`@solana-mobile/dapp-store-cli`): mint the
   Publisher, App, and Release NFTs (your keypair + a little SOL), then submit;
   review is ~3–5 business days.
4. Provide listing assets (icon, screenshots, description) and a **privacy
   policy** URL (the scanner sends only the token address you type to your own
   API; no accounts, no personal data — state that).

## What's verified vs. yours

- ✅ **Tested here:** the scoring engine and the API gather+score layer (offline,
  mocked data), plus a headless browser smoke-test of the UI.
- 👤 **Yours:** deploy + set `HELIUS_API_KEY`, add PNG icons, set the Jupiter
  referral, wrap + sign the APK, and mint the store NFTs.
