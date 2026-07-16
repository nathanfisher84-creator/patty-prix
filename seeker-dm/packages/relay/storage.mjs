// Storage adapters for the relay. The relay depends only on this interface, so
// production can swap the in-memory default for a real database by implementing
// the same shape. Everything stored is opaque (notes, session credit balances,
// spent payment signatures) — no identities, no plaintext.
//
// StorageAdapter:
//   appendNote(note)            -> seq (number)
//   getLog(since, limit)        -> { events:[{seq,note}], cursor, total }
//   createSession(token, credits)
//   getSession(token)           -> { credits } | null
//   setCredits(token, credits)
//   consumeSignature(sig)       -> true if newly consumed, false if already used
//   snapshot()                  -> serializable state (for the file adapter)

export function memoryStorage(initial) {
  const log = initial?.log ? [...initial.log] : [];
  const sessions = new Map(initial?.sessions ?? []);
  const usedSigs = new Set(initial?.usedSigs ?? []);
  let seq = initial?.seq ?? log.reduce((m, e) => Math.max(m, e.seq), 0);

  return {
    async appendNote(note) { const e = { seq: ++seq, note }; log.push(e); return e.seq; },
    async getLog(since, limit) {
      const events = log.filter(e => e.seq > since).slice(0, limit);
      return { events, cursor: events.length ? events[events.length - 1].seq : since, total: seq };
    },
    async createSession(token, credits) { sessions.set(token, { credits }); },
    async getSession(token) { return sessions.get(token) || null; },
    async setCredits(token, credits) { const s = sessions.get(token); if (s) s.credits = credits; },
    async consumeSignature(sig) { if (usedSigs.has(sig)) return false; usedSigs.add(sig); return true; },
    snapshot() { return { seq, log, sessions: [...sessions.entries()], usedSigs: [...usedSigs] }; },
  };
}

// Dev-only single-node persistence: load a JSON snapshot on start, write it back
// after each mutation (synchronously, best-effort). NOT for production scale —
// implement the StorageAdapter interface against a real DB (Postgres/Redis) for
// multi-node deployment. Kept simple and honest.
export async function fileStorage(path) {
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  let initial;
  if (existsSync(path)) { try { initial = JSON.parse(readFileSync(path, "utf8")); } catch { initial = undefined; } }
  const mem = memoryStorage(initial);
  const save = () => { try { writeFileSync(path, JSON.stringify(mem.snapshot())); } catch { /* best-effort */ } };
  return {
    async appendNote(n) { const r = await mem.appendNote(n); save(); return r; },
    async getLog(s, l) { return mem.getLog(s, l); },
    async createSession(t, c) { await mem.createSession(t, c); save(); },
    async getSession(t) { return mem.getSession(t); },
    async setCredits(t, c) { await mem.setCredits(t, c); save(); },
    async consumeSignature(s) { const r = await mem.consumeSignature(s); save(); return r; },
    snapshot() { return mem.snapshot(); },
  };
}
