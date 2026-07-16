// Credit deposit verification. A verifier maps a proof-of-payment (a confirmed
// Solana transaction signature) to an amount of relay credit. This is what turns
// the "modeled deposit" into a real one: the relay only credits a session after
// confirming lamports actually landed in its treasury on-chain, and each
// signature is single-use (replay protection is enforced by the relay via the
// storage adapter's consumeSignature).
//
// verifier(signature) -> { ok: boolean, credits?: number, lamports?: number, reason?: string }

// For tests / local dev: a fixed map of signature -> credits.
export function mockVerifier(map = {}) {
  return async signature => (map[signature] != null
    ? { ok: true, credits: map[signature], lamports: map[signature] }
    : { ok: false, reason: "no such payment (mock)" });
}

// Production verifier: confirm a SOL transfer to the treasury via JSON-RPC.
// Credits = floor(lamports_to_treasury / lamportsPerCredit). Robust check: read
// the treasury account's balance delta (post - pre) from tx meta, so it works
// regardless of how the transfer instruction was built. `fetchFn` injectable.
export function solanaRpcVerifier({ rpcUrl, treasury, lamportsPerCredit, minLamports = 1, fetchFn = fetch }) {
  if (!rpcUrl || !treasury || !lamportsPerCredit) throw new Error("solanaRpcVerifier needs rpcUrl, treasury, lamportsPerCredit");
  return async signature => {
    if (typeof signature !== "string" || signature.length < 32) return { ok: false, reason: "bad signature" };
    let json;
    try {
      const res = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      json = await res.json();
    } catch (e) { return { ok: false, reason: "rpc error: " + (e.message || e) }; }

    const tx = json?.result;
    if (!tx) return { ok: false, reason: "transaction not found or not yet confirmed" };
    if (tx.meta?.err) return { ok: false, reason: "transaction failed on-chain" };

    const keys = (tx.transaction?.message?.accountKeys || []).map(k => (typeof k === "string" ? k : k.pubkey));
    const i = keys.indexOf(treasury);
    if (i < 0) return { ok: false, reason: "treasury not in transaction" };

    const pre = tx.meta?.preBalances?.[i];
    const post = tx.meta?.postBalances?.[i];
    if (pre == null || post == null) return { ok: false, reason: "missing balance data" };
    const lamports = post - pre;
    if (lamports < minLamports) return { ok: false, reason: `paid ${lamports} lamports, need ≥ ${minLamports}` };

    return { ok: true, lamports, credits: Math.floor(lamports / lamportsPerCredit) };
  };
}
