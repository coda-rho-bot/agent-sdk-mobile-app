/**
 * Per-conversation UI metadata — pins and read cursors — persisted in
 * AsyncStorage (non-secret by definition; matches the desktop client's
 * settings-backed equivalents). Keyed by profile id so switching servers
 * never leaks state across accounts.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = (profileId: string) => `chat-meta:${profileId}`;

interface ChatMeta {
  /** Pinned conversation ids, in pin order (most recent pin first). */
  pinned: string[];
  /** conversationId -> last-seen timestamp (ms). Newer activity = unread. */
  readCursors: Record<string, number>;
}

const EMPTY: ChatMeta = { pinned: [], readCursors: {} };

async function load(profileId: string): Promise<ChatMeta> {
  try {
    const raw = await AsyncStorage.getItem(KEY(profileId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<ChatMeta>;
    // Guard against externally-corrupted shapes (null fields survive the
    // cast and crash .includes during render): coerce to known-good arrays.
    return {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
      readCursors:
        parsed.readCursors && typeof parsed.readCursors === "object" && !Array.isArray(parsed.readCursors)
          ? parsed.readCursors
          : {},
    };
  } catch {
    return EMPTY;
  }
}

async function save(profileId: string, meta: ChatMeta): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY(profileId), JSON.stringify(meta));
  } catch {
    // Storage full/unavailable — metadata is advisory, not load-bearing.
  }
}

export async function getChatMeta(profileId: string): Promise<ChatMeta> {
  return load(profileId);
}

export async function togglePin(profileId: string, conversationId: string): Promise<ChatMeta> {
  const meta = await load(profileId);
  const pinned = meta.pinned.includes(conversationId)
    ? meta.pinned.filter((id) => id !== conversationId)
    : [conversationId, ...meta.pinned];
  const next = { ...meta, pinned };
  await save(profileId, next);
  return next;
}

export async function markRead(
  profileId: string,
  conversationId: string,
  seenAt: number,
): Promise<ChatMeta> {
  const meta = await load(profileId);
  if ((meta.readCursors[conversationId] ?? 0) >= seenAt) return meta;
  const next = { ...meta, readCursors: { ...meta.readCursors, [conversationId]: seenAt } };
  await save(profileId, next);
  return next;
}

export async function markAllRead(
  profileId: string,
  items: { id: string; seenAt: number }[],
): Promise<ChatMeta> {
  const meta = await load(profileId);
  const readCursors = { ...meta.readCursors };
  for (const item of items) readCursors[item.id] = item.seenAt;
  const next = { ...meta, pinned: meta.pinned, readCursors };
  await save(profileId, next);
  return next;
}

export type { ChatMeta };
