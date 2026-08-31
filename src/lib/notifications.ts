/**
 * Notification settings and cascade resolution — adapted from the Letta
 * KMP client's Notifications.kt (Harry's design, Aug 23).
 *
 * Cascade: conversation → agent → server → app; strictly downward, no
 * cycles. Concrete values fire notifications; DEFAULT_* markers inherit
 * from the level above. App level is always concrete.
 *
 * AsyncStorage keys:
 *   letta.notif.<conversationId>      — per-conversation setting
 *   letta.notif.agent.<agentId>       — per-agent setting
 *   letta.notif.server.<profileId>    — per-server (connection) setting
 *   letta.notif.appDefault            — app-level master setting
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Notification setting values. CONCRETE values fire; DEFAULT_* inherit. */
export enum NotificationMode {
  OFF = "OFF",
  /** Run completion for runs started from ANY source (this app, desktop, CLI, web). */
  ALL_MESSAGES = "ALL_MESSAGES",
  /** Run completion only for runs started by a message from THIS app. */
  MOBILE_ONLY = "MOBILE_ONLY",
  // --- inheritance markers (never fire; resolve upward) ---
  AGENT_DEFAULT = "AGENT_DEFAULT",
  SERVER_DEFAULT = "SERVER_DEFAULT",
  APP_DEFAULT = "APP_DEFAULT",
}

const CONCRETE = new Set<NotificationMode>([
  NotificationMode.OFF,
  NotificationMode.ALL_MESSAGES,
  NotificationMode.MOBILE_ONLY,
]);

export function isConcrete(mode: NotificationMode): boolean {
  return CONCRETE.has(mode);
}

/** Human-readable label for UI. */
export function notificationLabel(mode: NotificationMode): string {
  switch (mode) {
    case NotificationMode.OFF: return "Off";
    case NotificationMode.ALL_MESSAGES: return "All messages";
    case NotificationMode.MOBILE_ONLY: return "Mobile only";
    case NotificationMode.AGENT_DEFAULT: return "Agent default";
    case NotificationMode.SERVER_DEFAULT: return "Server default";
    case NotificationMode.APP_DEFAULT: return "App default";
  }
}

/** Parse a persisted setting; unknown/legacy → fallback. */
export function parseMode(raw: string | null, fallback: NotificationMode): NotificationMode {
  if (!raw) return fallback;
  // Legacy pre-cascade value
  if (raw === "FINAL") return NotificationMode.MOBILE_ONLY;
  return Object.values(NotificationMode).find((m) => m === raw) ?? fallback;
}

/**
 * Resolve the EFFECTIVE (concrete) mode by walking the cascade upward.
 * Skip levels allowed; app level is the floor.
 */
export function resolveMode(
  conversationSetting: NotificationMode,
  agentSetting: NotificationMode,
  serverSetting: NotificationMode,
  appSetting: NotificationMode,
): NotificationMode {
  let level = conversationSetting;
  let hops = 0;
  while (!isConcrete(level) && hops < 6) {
    level =
      level === NotificationMode.AGENT_DEFAULT ? agentSetting
      : level === NotificationMode.SERVER_DEFAULT ? serverSetting
      : level === NotificationMode.APP_DEFAULT ? appSetting
      : level; // concrete or unknown — stop
    hops++;
  }
  return isConcrete(level) ? level : NotificationMode.OFF;
}

/** Label with resolved inheritance, e.g. "Agent default (Off)". */
export function labelWithResolution(setting: NotificationMode, resolved: NotificationMode): string {
  return isConcrete(setting)
    ? notificationLabel(setting)
    : `${notificationLabel(setting)} (${notificationLabel(resolved)})`;
}

// --- AsyncStorage persistence ---

const CONV_KEY = (conversationId: string) => `letta.notif.${conversationId}`;
const AGENT_KEY = (agentId: string) => `letta.notif.agent.${agentId}`;
const SERVER_KEY = (profileId: string) => `letta.notif.server.${profileId}`;
const APP_KEY = "letta.notif.appDefault";

export async function loadConversationSetting(conversationId: string): Promise<NotificationMode> {
  return parseMode(await AsyncStorage.getItem(CONV_KEY(conversationId)), NotificationMode.APP_DEFAULT);
}

export async function saveConversationSetting(conversationId: string, mode: NotificationMode): Promise<void> {
  await AsyncStorage.setItem(CONV_KEY(conversationId), mode);
}

export async function loadAgentSetting(agentId: string): Promise<NotificationMode> {
  return parseMode(await AsyncStorage.getItem(AGENT_KEY(agentId)), NotificationMode.SERVER_DEFAULT);
}

export async function saveAgentSetting(agentId: string, mode: NotificationMode): Promise<void> {
  await AsyncStorage.setItem(AGENT_KEY(agentId), mode);
}

export async function loadAppDefault(): Promise<NotificationMode> {
  return parseMode(await AsyncStorage.getItem(APP_KEY), NotificationMode.OFF);
}

export async function saveAppDefault(mode: NotificationMode): Promise<void> {
  await AsyncStorage.setItem(APP_KEY, mode);
}

export async function loadServerSetting(profileId: string): Promise<NotificationMode> {
  return parseMode(await AsyncStorage.getItem(SERVER_KEY(profileId)), NotificationMode.APP_DEFAULT);
}

export async function saveServerSetting(profileId: string, mode: NotificationMode): Promise<void> {
  await AsyncStorage.setItem(SERVER_KEY(profileId), mode);
}

/**
 * Convenience: resolve the effective mode for a conversation, loading all
 * cascade levels from AsyncStorage. Agent and server levels default to
 * APP_DEFAULT (inherit upward) when not yet configured.
 *
 * @param conversationId  conversation id
 * @param agentId         agent id
 * @param profileId       connection profile id (for server-level setting)
 */
export async function resolveEffectiveMode(
  conversationId: string,
  agentId: string,
  profileId?: string,
): Promise<NotificationMode> {
  const [conv, agent, server, app] = await Promise.all([
    loadConversationSetting(conversationId),
    loadAgentSetting(agentId),
    profileId ? loadServerSetting(profileId) : Promise.resolve(NotificationMode.APP_DEFAULT),
    loadAppDefault(),
  ]);
  return resolveMode(conv, agent, server, app);
}

// --- Reset functions ---

/**
 * Reset ALL downstream notification keys at the app level.
 * Deletes every letta.notif.* key except the app default.
 */
export async function resetAllAppDownstreamNotifications(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  if (!keys) return;
  const toDelete = keys.filter(
    (k) => k.startsWith("letta.notif.") && k !== "letta.notif.appDefault",
  );
  if (toDelete.length > 0) await AsyncStorage.multiRemove(toDelete);
}

/**
 * Reset all agent + conversation notification keys for a specific server.
 * Requires the agent list for this profile to know which agents to clear.
 */
export async function resetServerDownstreamNotifications(
  agentIds: string[],
): Promise<void> {
  const agentKeys = agentIds.map((id) => `letta.notif.agent.${id}`);
  // Also delete all conversation-level keys (can't distinguish by server).
  const allKeys = await AsyncStorage.getAllKeys();
  if (!allKeys) return;
  const convKeys = allKeys.filter(
    (k) => k.startsWith("letta.notif.") &&
      !k.startsWith("letta.notif.agent.") &&
      !k.startsWith("letta.notif.server.") &&
      k !== "letta.notif.appDefault",
  );
  await AsyncStorage.multiRemove([...agentKeys, ...convKeys]);
}

/**
 * Reset all conversation notification keys for a specific agent.
 * Requires the conversation list for this agent.
 */
export async function resetAgentDownstreamNotifications(conversationIds: string[]): Promise<void> {
  const convKeys = conversationIds.map((id) => `letta.notif.${id}`);
  await AsyncStorage.multiRemove(convKeys);
}
