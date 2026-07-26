# Always-on worker: Rug or Moon liquidity-watch Telegram bot.
#
# For container hosts (Railway / Render / Fly.io). Vercel does NOT use Dockerfiles,
# so the static sites in this repo (rug-or-moon/, the main site, etc.) are
# completely unaffected by this file. Node 20 has global fetch; the bot has zero
# npm dependencies, so there's nothing to install.
FROM node:20-slim
WORKDIR /app
COPY . .
CMD ["node", "scripts/liquidity-bot.mjs"]
