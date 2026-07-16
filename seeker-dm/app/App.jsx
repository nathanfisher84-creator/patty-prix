// seeker-dm — Seeker client (scaffold).
//
// A working end-to-end flow using the real packages: dedicated identity in
// secure storage, credit via a wallet-signed on-chain payment, name/address
// resolution, stealth messaging over a content-blind relay, and conversation
// threading. This is a STARTING POINT — not final UI polish. Build out proper
// navigation, onboarding, backup/restore, push notifications, and publish an
// SNS record so others can resolve your name. Status: app/README.md.
//
// ⚠️ Not built/run in-repo (no Android tooling/device); the Solana Mobile SDK
// and crypto-in-RN bindings must be verified on device (see README).

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { SafeAreaView, View, Text, TextInput, Button, FlatList, StyleSheet, Alert } from "react-native";
import { loadOrCreateIdentity, myMetaAddress } from "./src/identity";
import { createRelayConnection } from "./src/relay";
import { resolveRecipient } from "./src/names";
import { payForCredit } from "./src/wallet";
import { createConversationStore } from "@seeker-dm/core/conversations";

const RELAY_URL = "http://127.0.0.1:8787";   // set to your hosted relay
const TREASURY = "REPLACE_WITH_RELAY_TREASURY_ADDRESS";
const CREDIT_LAMPORTS = 5_000_000;           // how much SOL to deposit per top-up

export default function App() {
  const [identity, setIdentity] = useState(null);
  const [addr, setAddr] = useState("");
  const [relay] = useState(() => createRelayConnection(RELAY_URL));
  const [store] = useState(() => createConversationStore());
  const [funded, setFunded] = useState(false);
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [threads, setThreads] = useState([]);
  const [openPeer, setOpenPeer] = useState(null);
  const [status, setStatus] = useState("starting…");

  const refresh = useCallback(() => setThreads(store.list()), [store]);

  useEffect(() => {
    (async () => {
      const id = await loadOrCreateIdentity();
      setIdentity(id);
      setAddr(myMetaAddress(id));
      setStatus("ready");
    })().catch(e => setStatus("error: " + e.message));
  }, []);

  const fund = useCallback(async () => {
    try {
      const sig = await payForCredit({ toAddress: TREASURY, lamports: CREDIT_LAMPORTS });
      await relay.fund(sig);
      setFunded(true);
      setStatus("credit added");
    } catch (e) { setStatus("fund failed: " + e.message); }
  }, [relay]);

  const send = useCallback(async () => {
    try {
      const target = await resolveRecipient(to);
      if (!target) return Alert.alert("Can't resolve recipient", "Enter a .sol name (published) or a meta-address.");
      await relay.send(target, body, addr);
      store.addOutgoing(target, body, Date.now());
      setBody(""); setOpenPeer(target); refresh();
      setStatus("sent");
    } catch (e) { setStatus("send failed: " + e.message); }
  }, [relay, store, to, body, addr, refresh]);

  const poll = useCallback(async () => {
    if (!identity) return;
    try {
      const msgs = await relay.poll(identity);
      msgs.forEach(m => store.addIncoming(m));
      refresh();
      setStatus(`inbox: ${msgs.length} new`);
    } catch (e) { setStatus("poll failed: " + e.message); }
  }, [relay, identity, store, refresh]);

  const conversation = useMemo(() => (openPeer ? store.thread(openPeer) : []), [openPeer, store, threads]);

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.h}>seeker-dm</Text>
      <Text style={s.dim}>{status}</Text>

      <Text style={s.label}>Your address (share this)</Text>
      <Text selectable style={s.mono}>{addr || "…"}</Text>

      <View style={s.row}>
        <Button title={funded ? "credit ✓" : "add credit"} onPress={fund} disabled={funded} />
        <Button title="check inbox" onPress={poll} />
      </View>

      <Text style={s.label}>Message (to a .sol name or address)</Text>
      <TextInput style={s.input} value={to} onChangeText={setTo} autoCapitalize="none" placeholder="patty.sol or a meta-address" />
      <TextInput style={s.input} value={body} onChangeText={setBody} placeholder="message" />
      <Button title="send" onPress={send} disabled={!funded} />

      {openPeer ? (
        <>
          <Text style={s.label}>Conversation</Text>
          <FlatList
            data={conversation}
            keyExtractor={(m, i) => (m.stealthPub || m.stealthAddress || String(m.ts)) + i}
            renderItem={({ item }) => (
              <Text style={item.dir === "out" ? s.out : s.in}>{item.dir === "out" ? "→ " : "← "}{item.body}</Text>
            )}
          />
          <Button title="← all chats" onPress={() => setOpenPeer(null)} />
        </>
      ) : (
        <>
          <Text style={s.label}>Chats</Text>
          <FlatList
            data={threads}
            keyExtractor={t => t.peer}
            renderItem={({ item }) => (
              <Text style={s.thread} onPress={() => setOpenPeer(item.peer)}>
                {item.peer.slice(0, 10)}…  ·  {item.preview}
              </Text>
            )}
            ListEmptyComponent={<Text style={s.dim}>no chats yet</Text>}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 8 },
  h: { fontSize: 24, fontWeight: "700" },
  dim: { color: "#888" },
  label: { marginTop: 12, fontWeight: "600" },
  mono: { fontFamily: "monospace", fontSize: 12 },
  row: { flexDirection: "row", gap: 12, marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 },
  thread: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#eee" },
  in: { alignSelf: "flex-start", backgroundColor: "#eee", borderRadius: 8, padding: 8, marginVertical: 2 },
  out: { alignSelf: "flex-end", backgroundColor: "#d6ebff", borderRadius: 8, padding: 8, marginVertical: 2 },
});
