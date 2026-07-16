// Username → meta-address resolution.
//
// A Solana Name Service (`.sol`) domain resolves to a *wallet*, not to a
// seeker-dm messaging identity. So reachability-by-name is OPT-IN: a user who
// wants to be found publishes their meta-address into a record on their domain,
// and others resolve that record. Privacy-maximalists simply share their
// meta-address out of band and never publish — keeping the name↔identity link
// off any public index (see SECURITY.md: `.sol` names are a doxxing vector).
//
// This module is transport-agnostic: `makeResolver({ lookup })` turns any
// name→record lookup into a validated name→meta-address resolver. Two lookups
// ship: a local registry (dev/tests) and an SNS record lookup (production —
// its on-chain record-account derivation is the one integration point to wire
// against @bonfida/spl-name-service and verify on-device).

import { parseMetaAddress } from "./protocol.mjs";

const RECORD = "seeker-dm"; // the SNS record key that holds the meta-address

export function isValidMetaAddress(s) {
  try { parseMetaAddress(s); return true; } catch { return false; }
}

// Extract + validate a meta-address from raw record content (string or bytes).
export function parseMetaFromRecord(data) {
  if (data == null) return null;
  const s = (typeof data === "string" ? data : Buffer.from(data).toString("utf8")).trim();
  return isValidMetaAddress(s) ? s : null;
}

// Generic resolver: `lookup(name)` returns raw record content (or null).
export function makeResolver({ lookup }) {
  return {
    async resolve(name) {
      const n = String(name).trim().toLowerCase();
      if (!n) return null;
      const raw = await lookup(n);
      return parseMetaFromRecord(raw);
    },
  };
}

// Dev / test resolver: an in-memory { name -> metaAddress } map.
export function registryResolver(map = {}) {
  return makeResolver({ lookup: async name => map[name] ?? null });
}

// Production resolver over SNS. `deriveRecordAccount(name, record)` must return
// the on-chain account address that stores the record — wire it to
// @bonfida/spl-name-service (getRecordKeySync / record V2) and VERIFY on-device;
// the RPC fetch + parse below is exercised by tests with a mocked fetch.
export function snsResolver({ rpcUrl, deriveRecordAccount, fetchFn = fetch }) {
  if (!rpcUrl || typeof deriveRecordAccount !== "function") {
    throw new Error("snsResolver needs rpcUrl and deriveRecordAccount (wire @bonfida/spl-name-service)");
  }
  return makeResolver({
    lookup: async name => {
      const account = await deriveRecordAccount(name, RECORD);
      if (!account) return null;
      let json;
      try {
        const res = await fetchFn(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [account, { encoding: "base64" }] }),
        });
        json = await res.json();
      } catch { return null; }
      const b64 = json?.result?.value?.data?.[0];
      if (!b64) return null;
      // Record content is UTF-8 text (the meta-address), possibly with an SNS
      // header/padding — parseMetaFromRecord tolerates surrounding whitespace;
      // production should strip the exact SNS record header per the SDK.
      return Buffer.from(b64, "base64").toString("utf8");
    },
  });
}
