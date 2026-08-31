/**
 * Permission mode settings and cascade resolution — mirrors the notification
 * cascade in notifications.ts. The concrete values are the SDK's
 * PermissionMode strings; DEFAULT_* markers inherit from the level above.
 *
 * Cascade: conversation → agent → server → app; strictly downward, no
 * cycles. Concrete values are applied to the SDK; DEFAULT_* markers inherit
 * from the level above. App level is always concrete.
 *
 * AsyncStorage keys:
 *   letta.perm.<conversationId>      — per-conversation setting
 *   letta.perm.agent.<agentId>       — per-agent setting
 *   letta.perm.server.<profileId>    — per-server (connection) setting
 *   letta.perm.appDefault            — app-level master setting
 *
 * Legacy keys (migrated):
 *   letta.permMode.<conversationId>  — pre-cascade per-conversation
 *   letta.defaultPermissionMode      — pre-cascade app default
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PermissionMode } from "./letta/model";

/**
 * Extended permission mode: SDK concrete values + cascade inheritance markers.
 * The concrete values match the SDK's PermissionMode type exactly.
 */
export const PermissionCascadeMode = {
  STRICT: "strict",
  STANDARD: "standard",
  ACCEPT_EDITS: "acceptEdits",
  UNRESTRICTED: "unrestricted",
  // --- inheritance markers (never applied; resolve upward) ---
  AGENT_DEFAULT: "AGENT_DEFAULT",
  SERVER_DEFAULT: "SERVER_DEFAULT",
  APP_DEFAULT: "APP_DEFAULT",
} as const;

export type PermissionCascadeValue = (typeof PermissionCascadeMode)[keyof typeof PermissionCascadeMode];

/** Concrete permission modes (the SDK's actual values). */
const CONCRETE_PERMS = new Set<string>([
  PermissionCascadeMode.STRICT,
  PermissionCascadeMode.STANDARD,
  PermissionCascadeMode.ACCEPT_EDITS,
  PermissionCascadeMode.UNRESTRICTED,
]);

export function isConcretePerm(mode: string): boolean {
  return CONCRETE_PERMS.has(mode);
}

/** Cast a resolved cascade value to the SDK's PermissionMode type. */
export function toSdkPermissionMode(mode: PermissionCascadeValue): PermissionMode {
  if (isConcretePerm(mode)) return mode as PermissionMode;
  // Fallback for non-concrete (shouldn't happen after resolution)
  return PermissionCascadeMode.STANDARD as PermissionMode;
}

/** Human-readable label for UI. */
export function permissionLabel(mode: PermissionCascadeValue): string {
  switch (mode) {
    case PermissionCascadeMode.STRICT: return "Strict";
    case PermissionCascadeMode.STANDARD: return "Standard";
    case PermissionCascadeMode.ACCEPT_EDITS: return "Accept edits";
    case PermissionCascadeMode.UNRESTRICTED: return "Unrestricted";
    case PermissionCascadeMode.AGENT_DEFAULT: return "Agent default";
    case PermissionCascadeMode.SERVER_DEFAULT: return "Server default";
    case PermissionCascadeMode.APP_DEFAULT: return "App default";
    default: return mode;
  }
}

/** Detail string for concrete modes. */
export function permissionDetail(mode: PermissionCascadeValue): string {
  switch (mode) {
    case PermissionCascadeMode.STRICT: return "Every tool asks, even reads";
    case PermissionCascadeMode.STANDARD: return "Asks before risky tools";
    case PermissionCascadeMode.ACCEPT_EDITS: return "File edits are auto-approved";
    case PermissionCascadeMode.UNRESTRICTED: return "Everything auto-approved";
    default: return "";
  }
}

/** Parse a persisted setting; unknown/legacy → fallback. */
export function parsePerm(raw: string | null, fallback: PermissionCascadeValue): PermissionCascadeValue {
  if (!raw) return fallback;
  // Legacy pre-cascade keys
  if (raw === "strict" || raw === "standard" || raw === "acceptEdits" || raw === "unrestricted") return raw;
  return Object.values(PermissionCascadeMode).find((m) => m === raw) ?? fallback;
}

/**
 * Resolve the EFFECTIVE (concrete) permission mode by walking the cascade
 * upward. Skip levels allowed; app level is the floor.
 */
export function resolvePermission(
  conversationSetting: PermissionCascadeValue,
  agentSetting: PermissionCascadeValue,
  serverSetting: PermissionCascadeValue,
  appSetting: PermissionCascadeValue,
): PermissionCascadeValue {
  let level = conversationSetting;
  let hops = 0;
  while (!isConcretePerm(level) && hops < 6) {
    level =
      level === PermissionCascadeMode.AGENT_DEFAULT ? agentSetting
      : level === PermissionCascadeMode.SERVER_DEFAULT ? serverSetting
      : level === PermissionCascadeMode.APP_DEFAULT ? appSetting
      : level;
    hops++;
  }
  return isConcretePerm(level) ? level : PermissionCascadeMode.STANDARD;
}

/** Label with resolved inheritance, e.g. "Agent default (Standard)". */
export function permLabelWithResolution(setting: PermissionCascadeValue, resolved: PermissionCascadeValue): string {
  return isConcretePerm(setting)
    ? permissionLabel(setting)
    : `${permissionLabel(setting)} (${permissionLabel(resolved)})`;
}

// --- AsyncStorage persistence ---

const CONV_KEY = (conversationId: string) => `letta.perm.${conversationId}`;
const AGENT_KEY = (agentId: string) => `letta.perm.agent.${agentId}`;
const SERVER_KEY = (profileId: string) => `letta.perm.server.${profileId}`;
const APP_KEY = "letta.perm.appDefault";

// Legacy keys (for migration)
const LEGACY_CONV_KEY = (conversationId: string) => `letta.permMode.${conversationId}`;
const LEGACY_APP_KEY = "letta.defaultPermissionMode";

export async function loadConversationPerm(conversationId: string): Promise<PermissionCascadeValue> {
  const raw = await AsyncStorage.getItem(CONV_KEY(conversationId)) ?? await AsyncStorage.getItem(LEGACY_CONV_KEY(conversationId));
  return parsePerm(raw, PermissionCascadeMode.AGENT_DEFAULT);
}

export async function saveConversationPerm(conversationId: string, mode: PermissionCascadeValue): Promise<void> {
  await AsyncStorage.setItem(CONV_KEY(conversationId), mode);
}

export async function loadAgentPerm(agentId: string): Promise<PermissionCascadeValue> {
  return parsePerm(await AsyncStorage.getItem(AGENT_KEY(agentId)), PermissionCascadeMode.SERVER_DEFAULT);
}

export async function saveAgentPerm(agentId: string, mode: PermissionCascadeValue): Promise<void> {
  await AsyncStorage.setItem(AGENT_KEY(agentId), mode);
}

export async function loadServerPerm(profileId: string): Promise<PermissionCascadeValue> {
  return parsePerm(await AsyncStorage.getItem(SERVER_KEY(profileId)), PermissionCascadeMode.APP_DEFAULT);
}

export async function saveServerPerm(profileId: string, mode: PermissionCascadeValue): Promise<void> {
  await AsyncStorage.setItem(SERVER_KEY(profileId), mode);
}

export async function loadAppPermDefault(): Promise<PermissionCascadeValue> {
  const raw = await AsyncStorage.getItem(APP_KEY) ?? await AsyncStorage.getItem(LEGACY_APP_KEY);
  return parsePerm(raw, PermissionCascadeMode.STANDARD);
}

export async function saveAppPermDefault(mode: PermissionCascadeValue): Promise<void> {
  await AsyncStorage.setItem(APP_KEY, mode);
}

/**
 * Convenience: resolve the effective permission mode for a conversation,
 * loading all cascade levels from AsyncStorage.
 *
 * @param conversationId  conversation id
 * @param agentId         agent id
 * @param profileId       connection profile id (for server-level setting)
 */
export async function resolveEffectivePermission(
  conversationId: string,
  agentId: string,
  profileId?: string,
): Promise<PermissionCascadeValue> {
  const [conv, agent, server, app] = await Promise.all([
    loadConversationPerm(conversationId),
    loadAgentPerm(agentId),
    profileId ? loadServerPerm(profileId) : Promise.resolve(PermissionCascadeMode.APP_DEFAULT),
    loadAppPermDefault(),
  ]);
  return resolvePermission(conv, agent, server, app);
}

// --- Reset functions ---

/**
 * Reset ALL downstream notification/permission keys at the app level.
 * Deletes every letta.notif.* and letta.perm.* key except the app defaults.
 */
export async function resetAllAppDownstream(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  if (!keys) return;
  const toDelete = keys.filter(
    (k) =>
      (k.startsWith("letta.notif.") && k !== "letta.notif.appDefault") ||
      (k.startsWith("letta.perm.") && k !== "letta.perm.appDefault") ||
      k.startsWith("letta.permMode.") || // legacy
      k.startsWith("letta.notif.server.") ||
      k.startsWith("letta.perm.server.") ||
      k.startsWith("letta.notif.agent.") ||
      k.startsWith("letta.perm.agent."),
  );
  if (toDelete.length > 0) await AsyncStorage.multiRemove(toDelete);
}

/**
 * Reset all agent + conversation notification keys for a specific server.
 * Requires the agent list for this profile to know which agents to clear.
 */
export async function resetServerDownstreamNotifications(
  profileId: string,
  agentIds: string[],
): Promise<void> {
  // Delete server-level setting itself? No — the server default stays.
  // Delete agent-level keys for agents on this server.
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

// --- Permission reset functions ---

/**
 * Reset all agent + conversation permission keys for a specific server.
 * Requires the agent list for this profile.
 */
export async function resetServerDownstreamPermissions(
  agentIds: string[],
): Promise<void> {
  const agentKeys = agentIds.map((id) => `letta.perm.agent.${id}`);
  // Also delete all conversation-level permission keys (can't distinguish by server).
  const allKeys = await AsyncStorage.getAllKeys();
  if (!allKeys) return;
  const convKeys = allKeys.filter(
    (k) => k.startsWith("letta.perm.") &&
      !k.startsWith("letta.perm.agent.") &&
      !k.startsWith("letta.perm.server.") &&
      k !== "letta.perm.appDefault",
  );
  // Include legacy keys
  const legacyConvKeys = allKeys.filter((k) => k.startsWith("letta.permMode."));
  await AsyncStorage.multiRemove([...agentKeys, ...convKeys, ...legacyConvKeys]);
}

/**
 * Reset all conversation permission keys for a specific agent.
 * Requires the conversation list for this agent.
 */
export async function resetAgentDownstreamPermissions(conversationIds: string[]): Promise<void> {
  const convKeys = conversationIds.map((id) => `letta.perm.${id}`);
  // Also include legacy keys
  const legacyKeys = conversationIds.map((id) => `letta.permMode.${id}`);
  await AsyncStorage.multiRemove([...convKeys, ...legacyKeys]);
}
