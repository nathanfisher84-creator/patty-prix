// Device identity management — generate once, persist in the OS secure store.
//
// The dedicated messaging identity (view + spend keys) is created on first run
// and stored via expo-secure-store (Android Keystore-backed). It is NOT the
// user's funded wallet. On Seeker, the strongest option is to store it under
// Seed Vault; expo-secure-store is the portable baseline — see app/README.md
// "Key storage" for the hardening path an auditor will expect.

import * as SecureStore from "expo-secure-store";
import { createIdentity, exportIdentity, importIdentity, metaAddress } from "@seeker-dm/core";

const KEY = "seeker-dm.identity.v1";

// Returns the stored identity, creating and persisting one on first run.
export async function loadOrCreateIdentity() {
  const blob = await SecureStore.getItemAsync(KEY, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (blob) return importIdentity(blob);
  const id = createIdentity();
  await SecureStore.setItemAsync(KEY, exportIdentity(id), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return id;
}

export async function wipeIdentity() {
  await SecureStore.deleteItemAsync(KEY);
}

export function myMetaAddress(identity) {
  return metaAddress(identity);
}
