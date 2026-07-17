#!/usr/bin/env bash
# Build a clean token-site template tree from this repo's current state.
# Usage: scripts/build-template.sh <output-dir>
# Strips everything site-history-specific and the unrelated projects that
# share this repo, leaving the brand.json-driven site ready to push to a
# fresh repo (see README written below + REBRAND.md).
set -euo pipefail
OUT="${1:?usage: build-template.sh <output-dir>}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$OUT"
git -C "$SRC" archive HEAD | tar -x -C "$OUT"
cd "$OUT"

# other projects that live in this repo
rm -rf rug-or-moon seeker-dm
rm -f scripts/research-agent.mjs scripts/mev-paper-bot.mjs scripts/private-dm.mjs \
      scripts/sandwich-simulator.mjs scripts/whale-alerts.mjs scripts/whale-tracker.mjs \
      scripts/whale-watchlist.example.json scripts/build-template.sh
rm -f .github/workflows/whale-alerts.yml .github/workflows/research-newsletter.yml \
      .github/workflows/deploy.yml .github/workflows/model-compare.yml

# legacy branding assets + retired pages
rm -f bagworker-base.png og-patty.png og-jared.png wig.png glasses.png glasses-noarm.png pfp.html

cat > README.md <<'EOF'
# Token Site Template 🏭

A complete memecoin site, rebrandable from a single config file:

- **Homepage** — live price/mcap/volume ticker, holder count, whale share,
  ATH, buy funnel, lore, matrix-rain theme
- **Arcade game** (tap-to-play, weekly leaderboard with auto bot tags)
- **AI Print Shop** — prompt the mascot into any outfit (Gemini image model)
- **Airdrop Log** — tracks every wallet the airdrop wallet feeds
- **Maintenance page** + traffic dashboards

Everything brand-specific lives in **`brand.json`** — see `REBRAND.md`.
Push a brand.json change and the *Apply Brand* workflow restamps the whole
site and regenerates the OG link-preview cards automatically.

## Launching a new site from this template

1. **New repo from this one** (or let Claude do steps 1–3: paste it the
   contract address + airdrop wallet and it fetches the token metadata,
   writes brand.json, swaps the mascot and pushes).
2. **brand.json** — token name/ticker/mint/pair, airdrop wallet, X handle,
   theme, copy, AI character prompt. Replace the mascot PNG (square, ~800px).
3. Push — the workflow stamps everything.
4. **Vercel** — *Add New Project* → import the repo. Then in the project:
   - **Storage** → create a **new** free Upstash Redis and connect it
     (one per site — sharing a store mixes leaderboards between sites)
   - **Settings → Environment Variables** → `GEMINI_API_KEY` (Print Shop)
   - **Settings → Domains** → buy/attach the domain
5. Optional second project for a standalone Print Shop URL: same repo,
   **Root Directory = `printshop-app`**, same env vars.

## Ops notes

- `PRINT_GLOBAL` (default 200/day) caps AI image spend; `PRINT_SHUTOFF`
  (ISO date or `off`) schedules the shop going dark.
- To pause a site, restore the redirect in `vercel.json`
  (see git history) — `maintenance.html` is the holding page.
- `.github/workflows/probe.yml` screenshots any URL into the
  `probe-results` branch; `token-info.yml` fetches a mint's metadata into
  the `token-info` branch.
EOF

echo "template built at $OUT:"
find . -type f | sort
