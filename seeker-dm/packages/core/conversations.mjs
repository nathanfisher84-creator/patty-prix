// Conversation store — pure logic to thread messages by peer.
//
// The app decrypts notes (via the protocol core) into { from, body, ts, seq,
// stealthPub } and feeds them here. This groups them into per-peer threads,
// de-duplicates (a log can be pulled with overlap), and keeps deterministic
// ordering. No crypto, no I/O — just the data model the UI renders. The app is
// responsible for persisting a snapshot() to encrypted on-device storage.

export function createConversationStore(initial) {
  // peer(meta-address) -> Map(dedupeKey -> message)
  const threads = new Map(initial?.threads?.map(([p, msgs]) => [p, new Map(msgs.map(m => [dedupeKey(m), m]))]) ?? []);

  const put = (peer, msg) => {
    if (!peer) return;
    const t = threads.get(peer) ?? new Map();
    t.set(dedupeKey(msg), msg);
    threads.set(peer, t);
  };

  return {
    // Add a decrypted incoming message (keyed by its sender).
    addIncoming(msg) { put(msg.from, { ...msg, dir: "in" }); },

    // Record an outgoing message to `peer` (we don't get it back from the log).
    addOutgoing(peer, body, ts = 0) { put(peer, { from: null, to: peer, body, ts, dir: "out" }); },

    // All threads, most-recently-active first, with a preview.
    list() {
      return [...threads.entries()]
        .map(([peer, m]) => {
          const msgs = sorted(m);
          const last = msgs[msgs.length - 1];
          return { peer, count: msgs.length, lastTs: last?.ts ?? 0, preview: last?.body ?? "" };
        })
        .sort((a, b) => b.lastTs - a.lastTs);
    },

    // One thread's messages in chronological order.
    thread(peer) { return sorted(threads.get(peer) ?? new Map()); },

    snapshot() { return { threads: [...threads.entries()].map(([p, m]) => [p, [...m.values()]]) }; },
  };
}

// Incoming messages dedupe by log seq / stealth address; outgoing by body+ts.
function dedupeKey(m) {
  if (m.dir === "out") return "out:" + m.ts + ":" + m.body;
  return "in:" + (m.seq ?? m.stealthPub ?? m.stealthAddress ?? (m.ts + ":" + m.body));
}
function sorted(map) {
  return [...map.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}
