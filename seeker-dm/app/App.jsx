// seeker-dm — minimal end-to-end app flow (scaffold).
//
// Deliberately a single-file, no-navigation-library flow so the moving parts are
// legible and there's little unverifiable SDK surface: create/hold a dedicated
// identity, show your address, message a recipient address, and poll an inbox —
// all through the real identity/relay modules and the tested protocol core.
//
// This is a STARTING POINT, not a finished UI. Build out with proper navigation,
// a name-service (.sol) resolver in place of raw address entry, a contacts list,
// per-conversation threading, push notifications, and the wallet-funded credit
// deposit (see src/wallet.js). Status + build steps: app/README.md.

import React, { useEffect, useState, useCallback } from "react";
import { SafeAreaView, View, Text, TextInput, Button, FlatList, StyleSheet } from "react-native";
import { loadOrCreateIdentity, myMetaAddress } from "./src/identity";
import { createRelayConnection } from "./src/relay";

const RELAY_URL = "http://127.0.0.1:8787"; // set to your hosted relay

export default function App() {
  const [identity, setIdentity] = useState(null);
  const [addr, setAddr] = useState("");
  const [relay] = useState(() => createRelayConnection(RELAY_URL));
  const [funded, setFunded] = useState(false);
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [inbox, setInbox] = useState([]);
  const [status, setStatus] = useState("starting…");

  useEffect(() => {
    (async () => {
      const id = await loadOrCreateIdentity();
      setIdentity(id);
      setAddr(myMetaAddress(id));
      setStatus("identity ready");
    })().catch(e => setStatus("error: " + e.message));
  }, []);

  const fund = useCallback(async () => {
    // v1 models the deposit; production routes through wallet.payForCredit.
    await relay.fund(1.0);
    setFunded(true);
    setStatus("credit added");
  }, [relay]);

  const send = useCallback(async () => {
    if (!to || !body) return;
    try {
      await relay.send(to.trim(), body, addr);
      setBody("");
      setStatus("sent");
    } catch (e) { setStatus("send failed: " + e.message); }
  }, [relay, to, body, addr]);

  const poll = useCallback(async () => {
    if (!identity) return;
    try {
      const msgs = await relay.poll(identity);
      if (msgs.length) setInbox(prev => [...msgs, ...prev]);
      setStatus(`inbox: ${msgs.length} new`);
    } catch (e) { setStatus("poll failed: " + e.message); }
  }, [relay, identity]);

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

      <Text style={s.label}>Send to (recipient address)</Text>
      <TextInput style={s.input} value={to} onChangeText={setTo} autoCapitalize="none" placeholder="paste a meta-address" />
      <TextInput style={s.input} value={body} onChangeText={setBody} placeholder="message" />
      <Button title="send" onPress={send} disabled={!funded} />

      <Text style={s.label}>Inbox</Text>
      <FlatList
        data={inbox}
        keyExtractor={(m, i) => m.stealthAddress + i}
        renderItem={({ item }) => (
          <View style={s.msg}>
            <Text style={s.from}>{item.from ? item.from.slice(0, 10) + "…" : "unknown"}</Text>
            <Text>{item.body}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={s.dim}>no messages yet</Text>}
      />
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
  msg: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#eee" },
  from: { fontFamily: "monospace", fontSize: 11, color: "#666" },
});
