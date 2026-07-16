# Architecture — seeker-dm

A confidentiality-first messenger for the Solana Seeker: message a Solana
username with the social graph hidden from everyone outside the conversation.

## Components

```
packages/core     @seeker-dm/core   — protocol: identity, seal, scan, E2E crypto
packages/relay     @seeker-dm/relay  — content-blind store-and-forward + client
packages/crypto*   @seeker-dm/crypto — on-curve stealth (ed25519) — TO BUILD
app*               React Native app  — Seeker UI + Mobile Wallet Adapter — TO BUILD
```
`*` = not yet built; see "Build status" below.

## Data flow (send → receive)

```
 Sender device                    Relay (content-blind)              Recipient device
 ─────────────                    ────────────────────              ────────────────
 resolve @name → meta-address
 sealNote(meta, "hi")  ──POST /submit {token, note}──▶  append to log
   note = {viewTag, ephemeralPub,                        (opaque; can't read)
           stealthAddress, nonce,
           ciphertext}                                   GET /log?since=N ◀── poll
                                                         events ──────────▶ scanNote() with
                                                                            view key → decrypt
```

- **Identity.** A dedicated dual-key identity (view + spend), generated on
  device, distinct from the funded wallet. `metaAddress()` is the shareable
  public handle; a name service (`.sol`) resolves a username to it.
- **Seal.** Fresh ephemeral key per note → one-time stealth address + view tag +
  AES-256-GCM ciphertext. Identifies neither party.
- **Relay.** Append-only log of opaque notes. Prices spam via a per-note credit
  fee (deposit → session token → fee per submit). Reading is free. It cannot
  decrypt, cannot derive stealth addresses, cannot learn recipients.
- **Receive.** Recipient pulls the log by cursor and scans locally with the view
  key (view tag skips non-matches cheaply). The sender's address is inside the
  encrypted envelope, enabling replies without leaking to the relay.

## Why the graph stays private

The relay sees `{session token → posts N opaque notes}` and a log of one-time
addresses. It never sees a recipient (hidden in the stealth address it can't
interpret) and never sees content. Two notes to one person don't cluster. So the
"who talks to whom" graph — the thing chain-analysis tools reconstruct and the
thing content-only-encrypted messengers still leak — is not present in any
server-side record. The residual leaks are at the network layer (IP/timing) and
sender-session clustering; see SECURITY.md §3.

## Build status

| Layer | State | Verified |
|---|---|---|
| `@seeker-dm/core` protocol | built | ✅ unit + integration tests |
| `@seeker-dm/relay` server + client | built | ✅ real-HTTP integration test (localhost) |
| Audit docs (threat model) | written | n/a |
| `@seeker-dm/crypto` on-curve stealth (ed25519, bound spend authority) | built | ✅ tested (`@noble/curves` installs from npm; test asserts `G·p == P` — spend authority binds — and non-recipients can't derive it). Still requires independent audit before production. |
| React Native app (`app/`) — identity, wallet connect, relay wiring, e2e flow | **scaffold** | ⚠️ **not built/run** — needs Android tooling + device; SDK & crypto-in-RN bindings must be verified (see app/README.md) |
| Push notifications / relay hosting / persistence | **to build** | operational |

## Run the backend locally

```bash
cd seeker-dm
npm test                 # full relay + protocol integration test
node packages/relay/server.mjs   # start a relay on :8787
```

## Roadmap to a store-ready build

1. On-curve stealth crypto (ed25519 spend-authority binding) — code, then audit.
2. React Native app: MWA wallet connect, identity in Seed Vault/keystore,
   contacts (`.sol` resolution), conversation UI, relay client, notifications.
3. On-chain credit: verify real deposits before crediting a relay session.
4. Independent security audit (see SECURITY.md).
5. Relay hosting + persistence + rate limits; privacy policy + ToS.
6. dApp Store publishing: publisher/app/release NFTs, APK, listing, device QA.
```
Steps 4–6 require an auditor, your keys + SOL, hosting, legal, and a Seeker.
```
