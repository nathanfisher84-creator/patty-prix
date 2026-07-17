# Rebranding this site

Everything swappable lives in **`brand.json`**. To rebrand:

1. **Edit `brand.json`** — token (name/ticker/mint/pair), airdrop wallet,
   X handle, theme colors + fonts, copy (lore, game name, catchphrases,
   banners), and the AI character description for the Print Shop.
2. **Swap the mascot art** — replace the image named by `ai.baseImage`
   (square PNG, ~800×800) with the new character.
3. **Push to `main`** — the *Apply Brand* workflow stamps every page and
   API function and regenerates the OG link-preview cards automatically.
   (Or run it locally: `node scripts/apply-brand.mjs && python3 scripts/make-og.py`.)

The theme reaches everything, including the game's canvas art and the
matrix rain, which read the CSS variables at load.

**Not covered by the config** (ask Claude / edit by hand):
- the domain (registrar + Vercel settings + a handful of URLs)
- page structure, new sections, niche flavor copy
- Vercel env vars (GEMINI_API_KEY, KV, PRINT_* caps)

**Second token, separate site?** This repo is a template: GitHub →
*Use this template* → new repo → point a new Vercel project at it
(plus a KV store + `GEMINI_API_KEY`) → edit its `brand.json`.
