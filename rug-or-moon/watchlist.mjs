// Rug or Moon — watchlist diff/alert logic (pure, tested).
//
// The UI stores a small list of watched tokens in localStorage and periodically
// re-scans them. This module holds the *decision* logic — what counts as an
// alert-worthy change between two scans — kept pure so it's testable without a
// browser. No network, no storage: the UI owns those; this owns the rules.

// Freemium: how many tokens a free user can watch. Premium (a future auth +
// payment step — see README) lifts this. Nothing here charges anyone; the limit
// is advisory state the UI enforces.
export const FREE_WATCH_LIMIT = 5;

// A watched token's safety dropping by this many points is worth a heads-up
// even if it stays in the same tier.
export const SAFETY_DROP_ALERT = 20;

// Can this user add another token? Premium removes the ceiling.
export function canWatch(currentCount, isPremium = false) {
  if (isPremium) return { ok: true, limit: Infinity, remaining: Infinity };
  const remaining = Math.max(0, FREE_WATCH_LIMIT - currentCount);
  return {
    ok: currentCount < FREE_WATCH_LIMIT,
    limit: FREE_WATCH_LIMIT,
    remaining,
    reason: currentCount < FREE_WATCH_LIMIT ? null
      : `Free plan watches up to ${FREE_WATCH_LIMIT} tokens. Remove one or upgrade for unlimited.`,
  };
}

const TIER_RANK = { clean: 2, caution: 1, "high-risk": 0 };

// Compare a previous scan against a fresh one and return the alert-worthy
// changes. `prev`/`curr` are scanToken() results ({ safety, tier, flags,
// smartMoneyHolders, ... }). Returns an array of { level, kind, text } — empty
// when nothing notable moved. Purely additive: we only surface *deteriorations*
// and the one genuinely-good reversal (smart money arriving) so alerts stay
// signal, not noise.
export function diffScan(prev, curr) {
  const alerts = [];
  if (!prev || !curr || curr.error) return alerts;

  // Safety dropped materially.
  if (typeof prev.safety === "number" && typeof curr.safety === "number") {
    const drop = prev.safety - curr.safety;
    if (drop >= SAFETY_DROP_ALERT) {
      alerts.push({
        level: "red", kind: "safety-drop",
        text: `Safety fell ${drop} pts (${prev.safety} → ${curr.safety})`,
      });
    }
  }

  // Tier downgraded (clean → caution → high-risk).
  const pr = TIER_RANK[prev.tier], cr = TIER_RANK[curr.tier];
  if (pr != null && cr != null && cr < pr) {
    alerts.push({
      level: curr.tier === "high-risk" ? "red" : "yellow", kind: "tier-down",
      text: `Downgraded ${prev.tier} → ${curr.tier}`,
    });
  }

  // Smart money exited — a wallet we track no longer holds.
  const ps = prev.smartMoneyHolders ?? 0, cs = curr.smartMoneyHolders ?? 0;
  if (ps > 0 && cs < ps) {
    const gone = ps - cs;
    alerts.push({
      level: "red", kind: "smart-money-exit",
      text: cs === 0
        ? `Smart money fully exited (${ps} wallet${ps > 1 ? "s" : ""} gone)`
        : `Smart money trimming — ${gone} of ${ps} tracked wallet${ps > 1 ? "s" : ""} exited`,
    });
  } else if (cs > ps) {
    // The one good-news alert worth pushing: tracked smart money arrived.
    alerts.push({
      level: "green", kind: "smart-money-in",
      text: `Smart money moved in — now ${cs} tracked wallet${cs > 1 ? "s" : ""} holding`,
    });
  }

  // A new RED flag appeared that wasn't there before (e.g. authority re-enabled,
  // liquidity pulled). Matched by flag text so we don't re-alert on old ones.
  const prevReds = new Set((prev.flags || []).filter(f => f.level === "red").map(f => f.text));
  for (const f of (curr.flags || [])) {
    if (f.level === "red" && !prevReds.has(f.text)) {
      alerts.push({ level: "red", kind: "new-flag", text: `New red flag: ${f.text}` });
    }
  }

  return alerts;
}

// Roll a batch of per-token diffs into a single notification payload the UI can
// hand to the Notifications API. Returns null when nothing is alert-worthy.
// `results` = [{ token, symbol, alerts }].
export function summarizeAlerts(results) {
  const hits = (results || []).filter(r => r.alerts && r.alerts.length);
  if (!hits.length) return null;
  const worst = hits.some(r => r.alerts.some(a => a.level === "red"));
  const tokenWord = hits.length > 1 ? "tokens" : "token";
  const title = worst
    ? `🚩 ${hits.length} watched ${tokenWord} need attention`
    : `👀 ${hits.length} watched ${tokenWord} changed`;
  const body = hits
    .slice(0, 4)
    .map(r => `${r.symbol || short(r.token)}: ${r.alerts[0].text}`)
    .join("\n") + (hits.length > 4 ? `\n+${hits.length - 4} more` : "");
  return { title, body, count: hits.length, hasRed: worst };
}

function short(mint) {
  return mint ? mint.slice(0, 4) + "…" + mint.slice(-4) : "token";
}
