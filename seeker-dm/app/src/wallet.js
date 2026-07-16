// Funded-wallet link via Mobile Wallet Adapter (Seeker Seed Vault wallet).
//
// The funded wallet is used ONLY to pay for relay credit (an on-chain deposit),
// never as the messaging identity. Keeping the two separate is the whole point:
// the wallet that holds money and the wallet that receives messages must not be
// linkable. See app/README.md "Wallet vs identity".
//
// ⚠️ UNVERIFIED SDK BINDING. The Mobile Wallet Adapter API below is written
// against @solana-mobile/mobile-wallet-adapter-protocol and is illustrative —
// method names / shapes MUST be checked against the version you install (the
// SDK evolves). Do not assume this compiles as-is.

import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";

const APP_IDENTITY = { name: "seeker-dm", uri: "https://seeker-dm.app", icon: "favicon.ico" };

// Connect and return the funded wallet's public key (base64/base58 per SDK).
export async function connectWallet(cluster = "mainnet-beta") {
  return transact(async wallet => {
    const auth = await wallet.authorize({ cluster, identity: APP_IDENTITY });
    return auth.accounts[0].address;
  });
}

// Pay for relay credit: send `lamports` to the relay's deposit address, then
// hand the confirmed signature to the relay so it credits your session. v1 of
// the relay MODELS the deposit (no on-chain check) — the production relay
// verifies this signature before crediting. See SECURITY.md §5.
export async function payForCredit({ toAddress, lamports, cluster = "mainnet-beta" }) {
  return transact(async wallet => {
    await wallet.authorize({ cluster, identity: APP_IDENTITY });
    // Build + sign + send a transfer here with @solana/web3.js, then return the
    // signature. Left as an integration point — construct against the web3.js
    // version you pin, and confirm the tx before returning.
    throw new Error("payForCredit: wire up @solana/web3.js transfer + wallet.signAndSendTransactions, then confirm");
  });
}
