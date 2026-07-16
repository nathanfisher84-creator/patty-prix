# Go-live checklist — seeker-dm

The engineering is complete to the **audit line**. This is the path from here to
a live listing on the Solana dApp Store. Items marked 🔒 are gates you must not
skip; 👤 require your keys/SOL/hosting/legal; 🧪 are verifications to run.

## 0. Pre-flight (do first)

- 🧪 `cd seeker-dm && npm test` — 4 suites green.
- 🧪 `node bin/seeker-dm.mjs demo` — full stack end-to-end, relay content-blind.
- 🧪 `cd packages/crypto && npm install && npm test` — on-curve stealth (`G·p == P`).

## 1. Security audit 🔒

Engage an independent auditor. Point them at `SECURITY.md` (threat model +
scope) and the `packages/` code. The must-clear items are in SECURITY.md
"Known gaps" — especially: the on-curve stealth scheme + `@noble/curves`
binding, forward secrecy, network-layer metadata, and the relay's payment
verification against a hostile RPC. **No real users before sign-off.**

## 2. Finish + build the app 👤🧪

- Verify the crypto-in-RN path on device (quick-crypto polyfill + Metro alias, or
  a `@noble/*` shim) — `app/README.md`.
- Verify the Solana Mobile SDK bindings (MWA connect, `payForCredit`) against the
  versions you install; wire Seed Vault for identity storage.
- Finish onboarding, identity backup/restore, push notifications, and publish an
  SNS record so others can resolve your `.sol`.
- Build a signed release APK (`expo run:android` / EAS) on a Seeker.

## 3. Operate the relay 👤

- Implement the `StorageAdapter` (packages/relay/storage.mjs) against a real DB
  (Postgres/Redis) for multi-node durability; keep the in-memory/file ones for dev.
- Configure the payment verifier: your **treasury** address, a **trusted RPC**
  (not a public one you don't control), and `lamportsPerCredit`.
- Host it (HTTPS), add per-IP rate limits + monitoring, and set a data-retention
  policy (the relay stores opaque notes — decide TTL / pruning).

## 4. Legal 👤🔒

A messenger on the store needs a **privacy policy** and **terms of service**.
A starter privacy policy is below — **have a lawyer review it**; it is not legal
advice. Be honest about what the relay can and cannot see (it's content-blind but
sees IP/timing — SECURITY.md §3).

## 5. dApp Store publishing 👤

Per Solana Mobile's publishing docs (verify current steps):

1. Create a **publisher NFT** (your keypair + a little SOL).
2. Create the **app NFT** (name, package `app.seekerdm`, metadata).
3. Create a **release NFT** for each signed APK version.
4. Submit for review (typically a few days); fix any feedback; publish.
5. Prepare listing assets: icon, screenshots, description, the privacy policy URL.

---

## Privacy policy — STARTER (have a lawyer review; not legal advice)

> **seeker-dm Privacy Policy**
>
> seeker-dm is a confidential messenger. Your messaging identity is a keypair
> generated on your device and stored in its secure keystore; it is not your
> wallet, and we never receive it.
>
> **What we (the relay) can see:** opaque, end-to-end-encrypted message blobs
> addressed to one-time stealth addresses, and network metadata inherent to any
> internet service (your IP address and connection timing). We cannot read your
> messages, determine who you are messaging, or link your messages to you.
>
> **What we do not collect:** your name, phone number, email, contacts, message
> contents, or a record of who communicates with whom.
>
> **Payments:** relay credit is purchased with an on-chain transaction you sign;
> that transaction is public on Solana by its nature.
>
> **Retention:** encrypted message blobs are retained for [TTL] and then pruned.
>
> **Your control:** you hold your keys; losing them means losing access, and we
> cannot recover them. [Contact], [jurisdiction], [effective date].
