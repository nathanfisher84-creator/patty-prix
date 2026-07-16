// App name resolution. Dev builds resolve from a local registry (or accept a
// raw meta-address pasted directly); production wires the SNS resolver.
//
// ⚠️ For production, provide `deriveRecordAccount` from @bonfida/spl-name-service
// (getRecordV2Key / record derivation) and a trusted RPC URL, then swap
// `getResolver()` to return `snsResolver({ rpcUrl, deriveRecordAccount })`.
// Verify the SNS record parsing on-device — see packages/core/names.mjs.

import { registryResolver, isValidMetaAddress } from "@seeker-dm/core/names";

// Dev registry — replace/augment with the SNS resolver for production.
export function getResolver() {
  return registryResolver({
    // "patty.sol": "<meta-address>",
  });
}

// Accept either a `name.sol` (resolved) or a directly-pasted meta-address.
export async function resolveRecipient(input) {
  const s = String(input).trim();
  if (isValidMetaAddress(s)) return s;               // pasted address
  if (s.endsWith(".sol")) return getResolver().resolve(s); // name lookup
  return null;
}
