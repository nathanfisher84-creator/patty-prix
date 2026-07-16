// Known smart-money wallets for the alpha signal.
//
// Populate from the Patty Prix whale tracker (`node scripts/whale-tracker.mjs
// --json`) or curate by hand. Accepted shapes: ["addr", …] or
// [{ wallet, label }, …] (the tracker's --json output works directly).
//
// The scanner resolves a token's top-holder owners and flags overlap with this
// set — "smart money is holding this" — which is the app's real differentiator
// over momentum-only alpha.

import { readFileSync } from "node:fs";

export function parseSmartMoney(json) {
  const set = new Set(), labels = new Map();
  for (const e of Array.isArray(json) ? json : []) {
    const addr = typeof e === "string" ? e : e?.wallet;
    if (!addr) continue;
    set.add(addr);
    if (e && e.label) labels.set(addr, e.label);
  }
  return { set, labels };
}

// Load from SMART_MONEY_JSON env (inline JSON), else a bundled smart-money.json,
// else empty. Never throws — the app degrades to momentum-only alpha.
export function loadSmartMoney(env = process.env) {
  if (env.SMART_MONEY_JSON) {
    try { return parseSmartMoney(JSON.parse(env.SMART_MONEY_JSON)); } catch { /* ignore */ }
  }
  try {
    const raw = readFileSync(new URL("./smart-money.json", import.meta.url), "utf8");
    return parseSmartMoney(JSON.parse(raw));
  } catch { /* no bundled list */ }
  return { set: new Set(), labels: new Map() };
}

// Compute overlap of a token's holder owners with the smart-money set.
// Returns { count, labels } for the scoring engine.
export function matchSmartMoney(holderOwners, { set, labels }) {
  const hits = [...new Set(holderOwners.filter(o => o && set.has(o)))];
  return { count: hits.length, labels: hits.map(a => labels.get(a) || short(a)) };
}

const short = a => a.slice(0, 4) + "…" + a.slice(-4);
