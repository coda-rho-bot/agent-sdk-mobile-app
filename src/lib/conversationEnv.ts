/**
 * Per-conversation environment (computer) selection — app adapter over the
 * core module (@angus/letta-client-core env/conversationEnv). The logic
 * (key scheme, sandbox/JSON/inherit semantics, isSelector shape guard) lives
 * in the core, adapter-threaded over KeyValueStore; AsyncStorage implements
 * the contract here. Same `letta.env.<id>` keys — existing stored selections
 load unchanged.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  loadConversationEnv as coreLoad,
  saveConversationEnv as coreSave,
  type ConversationEnv,
  type KeyValueStore,
} from "@angus/letta-client-core";

const asyncStorageAdapter: KeyValueStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  delete: (key) => AsyncStorage.removeItem(key),
};

export type { ConversationEnv } from "@angus/letta-client-core";

export function loadConversationEnv(conversationId: string): Promise<ConversationEnv> {
  return coreLoad(asyncStorageAdapter, conversationId);
}

export function saveConversationEnv(
  conversationId: string,
  selector: Parameters<typeof coreSave>[2],
): Promise<void> {
  return coreSave(asyncStorageAdapter, conversationId, selector);
}
