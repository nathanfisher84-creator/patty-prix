# Ship Rug or Moon to the Seeker dApp Store — full walkthrough

A step-by-step guide for turning the live web app into a signed Android app and
publishing it to the Solana dApp Store. Written for a first-timer. Do it in one
sitting (~2–3 hours) or across a few — nothing here expires.

> **This is the source of truth for the *friendly* explanation. The official
> commands can change — when in doubt, cross-check Solana Mobile's docs:**
> <https://docs.solanamobile.com/dapp-publishing/intro>

---

## What you already have (nothing to redo)

- ✅ **Live app:** `https://patty-prix-rxu7.vercel.app/` (public, working).
- ✅ **Icons:** `icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`.
- ✅ **Screenshots:** `store/screenshot-1..4.png` (1080×2340).
- ✅ **Listing copy:** `store/LISTING.md`.
- ✅ **Privacy policy:** `https://patty-prix-rxu7.vercel.app/privacy.html`.
- ✅ **Seeker-exclusive unlock:** launch the app at `…/?edition=seeker` (Step B4).

---

## Before you start — gather these

| Thing | Where | Notes |
|-------|-------|-------|
| **A computer** | Mac / Windows / Linux | Where you'll run the commands. |
| **Node.js 18+** | [nodejs.org](https://nodejs.org) | You installed this for Phase 1 already. Check: `node --version`. |
| **Java JDK 17+** | comes with **Android Studio** | [developer.android.com/studio](https://developer.android.com/studio). Install Android Studio once; it brings the Java + Android build tools Bubblewrap needs. |
| **A Solana wallet keypair file** | see Step C2 | A `.json` keypair the publishing tool signs with. |
| **~0.1 SOL** (a few dollars) | any exchange → your wallet | Pays the tiny mint/transaction fees. The store itself is free. |

---

# PART A — Install the build tool (Bubblewrap)

Bubblewrap wraps your website into an Android app ("TWA" = Trusted Web Activity).

**A1.** Open your terminal and install it:
```bash
npm install -g @bubblewrap/cli
```

**A2.** The first time you run Bubblewrap it may offer to download the JDK and
Android SDK for you — say **yes**. (If you installed Android Studio, it can find
those automatically instead.)

---

# PART B — Build the Android app (the .apk)

**B1.** Make an empty folder to build in and go into it:
```bash
mkdir rug-or-moon-app && cd rug-or-moon-app
```

**B2.** Point Bubblewrap at your live app's manifest:
```bash
bubblewrap init --manifest https://patty-prix-rxu7.vercel.app/manifest.json
```

**B3.** It asks a series of questions. Sensible answers:

| Prompt | What to enter |
|--------|---------------|
| Domain | `patty-prix-rxu7.vercel.app` (auto-filled) |
| **Application name** | `Rug or Moon` |
| Short name | `Rug or Moon` |
| **Application ID** (package) | accept the default (e.g. `app.vercel.patty_prix_rxu7`) — keep whatever it suggests, it must stay the same forever |
| Display mode | `standalone` |
| Status bar color | accept default (`#0b0f17`) |
| **⭐ Launch / start URL** | **`/?edition=seeker`** ← this unlocks the Seeker-exclusive unlimited watchlist |
| Icon URL | accept default (it reads your 512 icon) |
| Maskable icon | `Yes` |
| Include support for… (shortcuts etc.) | defaults are fine |
| **Signing key** | choose **"Create new"** — see B5 |

> If you miss the launch-URL prompt, you can fix it after: open the generated
> `twa-manifest.json`, set `"startUrl": "/?edition=seeker"`, and re-run `build`.

**B4.** **Why `/?edition=seeker` matters:** the app detects that launch URL and
unlocks unlimited watchlist — the reason to install it on Seeker instead of using
the free web version. Don't skip it.

**B5.** **The signing key = your app's identity.** Bubblewrap creates a
`android.keystore` file and asks you to set passwords. **Write the passwords down
and back up that keystore file somewhere safe (password manager, cloud drive).**
If you ever lose it, you can **never** publish an update — you'd have to ship a
brand-new app. This is the #1 thing people regret losing.

**B6.** Build it:
```bash
bubblewrap build
```
Out comes **`app-release-signed.apk`** (and an `.aab`). The `.apk` is what the
dApp Store wants. Bubblewrap also prints a **SHA-256 fingerprint** — copy it, you
need it in Step B7.

**B7. (Optional but recommended) Remove the browser address bar.** Without this,
your app shows a thin URL bar at the top. To hide it, prove the app owns the
domain with a "Digital Asset Links" file:

1. Create a file in your repo at **`rug-or-moon/.well-known/assetlinks.json`**:
   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": {
       "namespace": "android_app",
       "package_name": "PASTE_YOUR_APPLICATION_ID",
       "sha256_cert_fingerprints": ["PASTE_THE_SHA256_FINGERPRINT_FROM_B6"]
     }
   }]
   ```
2. Replace the two placeholders with your Application ID (from B3) and the
   fingerprint (from B6).
3. Commit + push. It deploys to
   `https://patty-prix-rxu7.vercel.app/.well-known/assetlinks.json`.
4. (Ping me and I'll wire this file in for you once you have the two values.)

---

# PART C — Publish to the dApp Store

**C1.** Follow Solana Mobile's publishing guide alongside this — it has the exact,
current CLI commands: <https://docs.solanamobile.com/dapp-publishing/intro>.
Broadly, you'll install their tool and drive it with a `config.yaml`.

**C2. Make a publishing wallet (keypair file).** If you have the Solana CLI:
```bash
solana-keygen new --outfile ~/rug-or-moon-publisher.json
```
Then send **~0.1 SOL** to the address it prints. (No Solana CLI? The publishing
docs show how to create/point at a keypair.) **Back this file up too.**

**C3. Fill in the listing config.** The publishing tool generates a `config.yaml`.
Everything it needs is already prepared — copy from:
- **Text** (name, description, category, tags, contact): `store/LISTING.md`
- **Icon:** `icons/icon-512.png`
- **Screenshots:** `store/screenshot-1..4.png`
- **Privacy policy URL:** `https://patty-prix-rxu7.vercel.app/privacy.html`
- **APK:** the `app-release-signed.apk` from Part B

**C4. Mint the three records.** Publishing creates three small on-chain NFTs; each
asks your wallet to approve a ~1-cent transaction:
1. **Publisher** (you — done once ever)
2. **App** (Rug or Moon — done once)
3. **Release** (this version — repeat for each future update)

Using the tool's commands (names per the current docs), it's roughly:
`create publisher` → `create app` → `create release` → `publish submit`.

**C5. Submit for review.** The final `submit` sends it to Solana Mobile. A human
reviews it (usually a few business days). Approved → **live on the Seeker dApp
Store.** 🎉

---

## Keeping it Seeker-exclusive

- **Don't** publish the `.apk` to the Google Play Store or other Android stores.
- The web app stays up (the Android app loads it), but it's the *limited* version
  (5-token watchlist) — the full experience lives in the Seeker install. That's
  your exclusivity.

## Shipping an update later

1. Change the code → push (Vercel redeploys the site instantly; the app loads the
   new site automatically — most updates need nothing else).
2. Only if you change the Android shell itself: bump the version, `bubblewrap
   build` again **with the same keystore**, then `create release` + `publish
   submit` again.

## Troubleshooting

- **`bubblewrap: command not found`** → reopen your terminal, or re-run
  `npm install -g @bubblewrap/cli`.
- **Build fails about Java/JDK/Android SDK** → install Android Studio and let it
  finish its first-run setup, then retry `bubblewrap build`.
- **App shows a URL bar** → you skipped B7 (asset links), or the fingerprint /
  package name don't match. Re-check both values.
- **Publish rejected** → read the reviewer's note; most rejections are a missing
  screenshot, privacy URL, or a broken link. Everything here is prepared, so it's
  usually a quick fix.

---

**When you sit down to do this, just message me at each step** — paste what the
terminal shows and I'll tell you exactly what to type next, and I'll fill in the
`assetlinks.json` for you once Bubblewrap gives you the fingerprint.
