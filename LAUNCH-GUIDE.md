# Launching a new token website — the owner's guide

Written for zero technical experience, phone-friendly. Your total hands-on
time is about **5 minutes**; Claude does everything else.

---

## Part 1 — Make an empty home for the new site's code (GitHub, ~1 min)

GitHub is where the website's files live. Each website gets its own
separate "repository" (think: its own folder in the cloud), so new sites
can never break the ones already running.

1. Open **github.com** in your browser and sign in.
2. Tap the **+** button (top right corner) → tap **New repository**.
3. In "Repository name" type a short name for the new site, all lowercase,
   dashes instead of spaces — e.g. `bull-site`.
4. Tap **Private** (so only you and Claude can see the code).
5. **Do not** tick "Add a README file" — leave everything else alone.
6. Tap the green **Create repository** button. You'll land on an empty page
   with setup instructions — ignore them, you're done here.

## Part 2 — Let Claude into that new folder (GitHub, ~30 sec)

1. Go to **github.com/settings/installations**
2. Find the **Claude** app in the list → tap **Configure**.
3. Under "Repository access", tap **Select repositories** and add the repo
   you just created (e.g. `bull-site`).
4. Tap **Save**.

## Part 3 — Tell Claude to build it (~10 sec of your time)

1. Start a **new Claude Code session**. When it asks which repositories to
   use, tick **both**: `patty-prix` (it holds the site template) **and**
   your new repo (e.g. `bull-site`).
2. Send one message with:
   - the token's **contract address** (the long code ending in "pump")
   - the **airdrop wallet** address
   - the **mascot picture** if you have one (attach it) — otherwise Claude
     uses the token's official icon
   - any wishes: colors, vibe, website domain you want
3. Claude fetches the token's name and details, builds the whole branded
   site, and pushes it to your new repo. It will tell you when it's done.

## Part 4 — Put the site online (Vercel, ~3 min)

Vercel is the service that turns the code into a live website.

1. Open **vercel.com** and sign in.
2. Tap **Add New…** → **Project**.
3. You'll see a list of your GitHub repositories. Find the new one
   (e.g. `bull-site`) and tap **Import** next to it.
4. Don't change any settings — just tap **Deploy** and wait ~1 minute.

**Connect a database** (powers the game leaderboard and the AI print shop
counter — each site needs its OWN, never reuse one):

5. Inside the new project, tap the **Storage** tab.
6. Tap **Create Database** → choose **Upstash** (Redis) → free plan →
   **Create** → **Connect Project**.

**Add the AI key** (lets the Print Shop generate pictures):

7. Tap **Settings** → **Environment Variables**.
8. In "Name" type exactly: `GEMINI_API_KEY`
   In "Value" paste your Google AI key (the one starting with `AQ.` from
   aistudio.google.com — the same key works for all your sites). Tap **Save**.
9. Go to the **Deployments** tab, tap the **⋯** on the top row →
   **Redeploy** (new keys only take effect after a redeploy).

## Part 5 — The website address (Vercel, ~1 min)

1. Still in the project: **Settings** → **Domains**.
2. Type the address you want (e.g. `bullsite.xyz`) → if you don't own it
   yet, Vercel shows a **Buy** button (usually $1–2/year) — buy it there
   and everything configures itself automatically.
3. Wait a few minutes. Tell Claude — it will check the live site for you
   and send you a screenshot.

---

## After launch — everyday changes

Just tell Claude in a session that has that site's repo. Examples:
- "change the colors to red and gold" · "new mascot picture attached"
- "update the airdrop wallet to …" · "pause the site" / "bring it back"
- "make the game harder" · anything else

## If something looks wrong

Tell Claude what you see (a screenshot helps). Claude can check the live
site, the code, and Vercel's logs itself.
