# seeker-dm 🕵️

A **confidentiality-first messenger** for the Solana [Seeker](https://solanamobile.com/)
dApp Store. Message a Solana username, with the social graph hidden from
everyone outside the conversation — the wedge that phone-number messengers and
even content-encrypted crypto messengers (SolChat, Dialect) structurally can't
offer.

> **Status: pre-audit backend.** The protocol core and relay are built and
> tested; the on-curve crypto hardening and the mobile app are next. **Not yet
> safe to ship to real users** — read [SECURITY.md](./SECURITY.md) first.

## What's here

| Package | What it is | Verified |
|---|---|---|
| [`packages/core`](./packages/core) | Protocol: dedicated identities, stealth one-time addresses, view-key scanning, E2E encryption (X25519 + HKDF + AES-256-GCM) | ✅ tested |
| [`packages/relay`](./packages/relay) | Content-blind store-and-forward relay + client. Prices spam via per-note credit; can't read messages or learn the graph | ✅ tested against a real HTTP server |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Components, data flow, why the graph stays private | — |
| [SECURITY.md](./SECURITY.md) | Threat model, what's enforced vs the audit scope | — |

| [`packages/crypto`](./packages/crypto) | On-curve ed25519 stealth with **bound spend authority** (production replacement for the core's hash-commitment stealth) | ⚠️ written, **unverified here** — needs `npm install` (`@noble/curves`); run its test on a networked machine |

**To build next:** the React Native app (Seeker UI, Mobile Wallet Adapter, Seed
Vault key storage). See ARCHITECTURE.md → Build status.

## Try the backend

```bash
cd seeker-dm
npm test    # spins up a real relay on localhost and runs a full send/receive
            # round trip + the privacy invariants (20 checks)
```

Run a relay standalone:

```bash
node packages/relay/server.mjs        # listens on 127.0.0.1:8787
```

## The confidentiality properties (enforced + tested)

- **Dedicated identity** — messaging keys are separate from your funded wallet.
- **Stealth addresses** — a fresh one-time address per message; unlinkable, and
  only your view key detects a note (even someone with your public address
  can't).
- **E2E encryption** — only the recipient decrypts; tampering is caught.
- **Graph-private + content-blind relay** — the server stores opaque notes and
  never learns who talks to whom or what they say.
- **Spam has a cost** — sending draws down prepaid credit; reading is free.

See [SECURITY.md](./SECURITY.md) for the **known gaps** that are the point of the
audit — most importantly, binding on-curve *spend authority* to the stealth
address (not done yet), forward secrecy, network-layer metadata, and moving the
credit deposit on-chain.

## License

MIT (see package manifests).
