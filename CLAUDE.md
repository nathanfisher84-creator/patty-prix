# Working with this project

## About the owner — READ FIRST

The owner has **no technical experience**. Whenever they must do something
manually (GitHub settings, Vercel dashboard, DNS, app stores — anything
Claude cannot do for them), explain it as a complete beginner walkthrough:

- number every step, one action per step
- say exactly where to tap/click, what the button is called, and what the
  screen should look like after
- never assume they know terms like "repo", "DNS", "env var" — say what the
  thing is in plain words the first time it comes up
- they usually work from a phone — prefer phone-friendly instructions
- after they finish, verify the result yourself (probe workflow, Vercel
  MCP, DNS check) instead of asking them to confirm technical details

## What this repo is

The live memecoin website (currently $JARED at jaredfromsubway.xyz) AND the
master copy of a reusable token-site template:

- `brand.json` — single config for token/wallets/theme/copy/AI character;
  `scripts/apply-brand.mjs` stamps it everywhere; `.github/workflows/brand.yml`
  does that automatically on push. See `REBRAND.md`.
- `scripts/build-template.sh <dir>` — builds a clean template tree for a new
  site repo (strips the unrelated projects below + legacy assets).
- `LAUNCH-GUIDE.md` — the owner's step-by-step guide for launching a new
  token site. Follow it when they say "new website for token X".
- Other projects share this repo (`rug-or-moon/`, `seeker-dm/`, whale/research
  scripts + workflows) — they belong to other sessions; leave them alone.

## Conventions

- Develop on the designated claude/* branch, PR to main, squash-merge; the
  user has always wanted PRs merged immediately after tests pass.
- The sandbox has no outbound internet: use the GitHub Actions workflows as
  remote eyes — `probe.yml` (screenshot any URL → probe-results branch),
  `token-info.yml` (fetch a mint's DexScreener/pump.fun metadata →
  token-info branch), `healthcheck.yml`.
- Never hardcode API keys in this public repo — keys live in Vercel env vars.
- Test before shipping: node handler tests for `api/*.mjs`, Playwright
  (executablePath `/opt/pw-browsers/chromium-*/chrome-linux/chrome`) for pages.
