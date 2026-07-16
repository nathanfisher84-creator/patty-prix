// Crypto polyfill for React Native — MUST be imported before anything that
// touches the protocol core.
//
// The shared @seeker-dm/core and @seeker-dm/crypto packages use Node's `crypto`
// (X25519, HKDF, AES-256-GCM, SHA). React Native has no such module, so we
// provide it with react-native-quick-crypto. Two things are required:
//
//   1. This import, first, at the app entry point (see index.js).
//   2. A Metro resolver alias so `node:crypto` / `crypto` resolve to
//      react-native-quick-crypto. Add to metro.config.js:
//
//        config.resolver.extraNodeModules = {
//          crypto: require.resolve("react-native-quick-crypto"),
//          "node:crypto": require.resolve("react-native-quick-crypto"),
//          buffer: require.resolve("@craftzdog/react-native-buffer"),
//          stream: require.resolve("readable-stream"),
//        };
//
// ⚠️ VERIFY on device: quick-crypto must expose the primitives the core uses
// (diffieHellman for X25519, hkdfSync, createCipheriv 'aes-256-gcm', jwk key
// import). If any is missing in your quick-crypto version, either upgrade it or
// build a small @noble/* shim (@noble/curves + @noble/ciphers + @noble/hashes)
// — noble is pure JS and always works in RN. This is a required pre-audit
// integration check.

import { install } from "react-native-quick-crypto";
install();
