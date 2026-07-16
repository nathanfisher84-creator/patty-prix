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
| `@seeker-dm/core` protocol (identity, seal/scan, names, conversations) | built | ✅ unit + integration tests |
| `@seeker-dm/relay` server + client — content-blind, on-chain deposit verification, replay protection, pluggable storage, rate limiting | built | ✅ real-HTTP integration + payments/storage tests |
| `@seeker-dm/crypto` on-curve stealth (ed25519, bound spend authority, point validation) | built | ✅ tested against `@noble/curves` (`G·p == P`; small-order/off-curve points rejected) |
| `.sol` name resolution (opt-in) | built | ✅ registry + SNS RPC/parse tested (SNS record-account derivation is the one flagged integration point) |
| Conversation store (threading/dedupe/snapshot) | built | ✅ tested |
| Reference CLI (`bin/seeker-dm.mjs demo`) — runs the whole stack end-to-end | built | ✅ runs |
| Audit docs (threat model) | written | n/a |
| React Native app (`app/`) — identity in secure store, wallet connect, name resolution, threaded UI | **scaffold** | ⚠️ **not built/run** — needs Android tooling + device; SDK & crypto-in-RN bindings must be verified (app/README.md) |
| Relay hosting / durable DB adapter / push notifications | **operational** | owner (implement StorageAdapter for a real DB; host it) |

Run everything: `cd seeker-dm && npm test` (4 suites) and
`node bin/seeker-dm.mjs demo` (full-stack end-to-end).

## Run the backend locally

```bash
cd seeker-dm
npm test                 # full relay + protocol integration test
node packages/relay/server.mjs   # start a relay on :8787
```

## Roadmap to a store-ready build

Engineering to the audit line is **done** (protocol, on-curve crypto, relay with
verified on-chain deposits + persistence interface + rate limiting, name
resolution, conversation store, reference CLI, and the app scaffold). Remaining:

1. **Independent security audit** (see SECURITY.md) — the gate before real users.
2. Build/run the **app** on a Seeker: verify the Solana Mobile SDK + crypto-in-RN
   bindings, finish onboarding/backup/notifications, publish an SNS record.
3. **Operate** the relay: implement the `StorageAdapter` against a real DB, host
   it, configure the treasury + a trusted RPC for the payment verifier.
4. **Privacy policy + ToS** (store-required for a messenger).
5. **dApp Store publishing**: publisher/app/release NFTs, APK, listing, device QA.

```
Steps 1, 3–5 require an auditor, your keys + SOL, hosting, legal, and a Seeker.
```
