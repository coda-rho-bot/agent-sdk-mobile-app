/**
 * Pinned-item storage for the list screens — a per-device UI preference
 * (AsyncStorage), not server state.
 *
 * Keys:
 *   letta.pin.agent.<profileId>   — pinned agent ids on that server
 *   letta.pin.conv.<agentId>      — pinned conversation ids of that agent
 *   letta.pin.profile             — pinned server profile ids
 *
 * Pinned items sort into a leading section on their list; ordering within
 * the section follows the list's existing sort.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

async function loadSet(key: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

async function saveSet(key: string, ids: Set<string>): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify([...ids]));
}

export function pinnedAgentsKey(profileId: string): string {
  return `letta.pin.agent.${profileId}`;
}

export function pinnedConversationsKey(agentId: string): string {
  return `letta.pin.conv.${agentId}`;
}

export const PINNED_PROFILES_KEY = "letta.pin.profile";

export async function loadPinned(key: string): Promise<Set<string>> {
  return loadSet(key);
}

/** Toggle membership; returns the updated set (also persisted). */
export async function togglePinned(key: string, id: string): Promise<Set<string>> {
  const set = await loadSet(key);
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
  await saveSet(key, set);
  return set;
}
