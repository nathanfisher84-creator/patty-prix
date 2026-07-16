// App-side relay wrapper. Thin layer over @seeker-dm/relay's client using RN's
// global fetch (works out of the box in React Native). Holds the base URL and
// the credit session token; exposes send + incremental receive with a cursor.

import { deposit, sendMessage, receiveMessages } from "@seeker-dm/relay/client";

export function createRelayConnection(baseUrl) {
  let sessionToken = null;
  let cursor = 0;

  return {
    baseUrl,
    get cursor() { return cursor; },

    // v1: models a deposit. Production: pass a confirmed on-chain payment
    // signature the relay verifies before crediting (see wallet.payForCredit).
    async fund(amountUsd) {
      const res = await deposit(baseUrl, amountUsd);
      if (res.sessionToken) sessionToken = res.sessionToken;
      return res;
    },

    async send(recipientMetaAddr, body, myMetaAddr) {
      if (!sessionToken) throw new Error("no credit — call fund() first");
      return sendMessage(baseUrl, sessionToken, recipientMetaAddr, body, myMetaAddr);
    },

    // Pull new messages for this identity since the last cursor.
    async poll(identity) {
      const { messages, cursor: next } = await receiveMessages(baseUrl, identity, cursor);
      cursor = next;
      return messages;
    },
  };
}
