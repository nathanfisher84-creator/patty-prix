# @seeker-dm/app — Seeker client (scaffold)

The React Native / Expo app for the Seeker dApp Store.

> **Status: SCAFFOLD, not a built app.** This was written but **not compiled,
> run, or verified** — the build sandbox has no Android tooling, no network, and
> no device, and the Solana Mobile SDK specifics are beyond what could be
> checked here. Treat every SDK/crypto binding below as *verify before trust*.
> The tested, verifiable parts of this project are `packages/core` and
> `packages/relay`; the security-critical `packages/crypto` is written but must
> be run on a networked machine (see its README). This app ties them together.

## What's here

| File | Role |
|---|---|
| `index.js` | Entry — installs the crypto polyfill first, then mounts the app |
| `src/polyfill.js` | `react-native-quick-crypto` install + the required Metro alias |
| `src/identity.js` | Create/persist the dedicated messaging identity in secure storage |
| `src/wallet.js` | Mobile Wallet Adapter connect + pay-for-credit (funded wallet ≠ identity) |
| `src/relay.js` | App wrapper over the relay client (fund / send / poll) |
| `App.jsx` | Minimal end-to-end flow: identity → address → send → inbox |

## The two integration realities you must handle

1. **Crypto in React Native.** The shared core uses Node's `crypto`, which RN
   lacks. `src/polyfill.js` installs `react-native-quick-crypto` and documents
   the **Metro resolver alias** (`node:crypto` → quick-crypto) that makes the
   shared packages resolve. **Verify** quick-crypto exposes the primitives the
   core uses (X25519 `diffieHellman`, `hkdfSync`, AES-256-GCM, JWK key import).
   If not, drop in a `@noble/*` shim (pure JS, always works in RN). This is a
   pre-audit blocker — confirm crypto works on-device before anything else.
2. **Wallet vs identity.** The Mobile Wallet Adapter wallet (Seed Vault) is used
   **only** to pay for relay credit. It is never the messaging identity — that's
   a separate key in secure storage. Keeping them unlinkable is the product's
   entire premise; don't collapse them for convenience.

## Build & run (on a networked dev machine)

```bash
# from repo root: install workspaces so @seeker-dm/* resolve
npm install

cd seeker-dm/app
# pin real versions (package.json ships '*' placeholders):
npx expo install expo expo-secure-store react react-native react-native-quick-crypto
npm i @solana-mobile/mobile-wallet-adapter-protocol-web3js @solana/web3.js

# add the Metro alias from src/polyfill.js to metro.config.js, then:
npx expo run:android      # on a connected Seeker / Android device
```

Run a relay for it to talk to (`node ../packages/relay/server.mjs`) and set
`RELAY_URL` in `App.jsx` to your hosted relay.

## Key storage — hardening path (audit will expect this)

`src/identity.js` uses `expo-secure-store` (Android Keystore) as the portable
baseline. On Seeker, evaluate storing the messaging identity under **Seed Vault**
for hardware-backed custody, and require device auth (biometric/PIN) to unlock
scanning. Never write identity private keys to plaintext storage or logs.

## What still needs building for a real app

- `.sol` / name-service resolution in place of pasting raw meta-addresses.
- Contacts + per-conversation threading and history (local encrypted store).
- Background polling / push notifications (the relay is pull-based today).
- The funded-wallet credit deposit end-to-end (`wallet.payForCredit` is a stub).
- Proper onboarding, backup/restore of the identity, and account recovery UX.
- The on-curve `@seeker-dm/crypto` swapped in for the core's stealth (prod).

## Then, before the store (owner tasks)

Independent security audit → relay hosting/persistence → privacy policy + ToS →
dApp Store publishing (publisher/app/release NFTs, APK, listing, device QA).
See `../SECURITY.md` and `../ARCHITECTURE.md`.
