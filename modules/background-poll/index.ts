import { requireNativeModule } from "expo";

export interface NativeConversationSpec {
  conversationId: string;
  agentId: string;
  title: string;
  /** Agent display name — the MessagingStyle Person (contact) name. */
  agentName?: string;
  /**
   * One-shot watch for MOBILE_ONLY conversations with a local run in
   * flight: notify the turn-boundary completion, then retire the spec.
   * (Regular specs poll until re-registered.)
   */
  onlyLocalRun?: boolean;
}

export interface NativePollOptions {
  /** Conversations to poll (those resolved to ALL_MESSAGES). */
  conversations: NativeConversationSpec[];
  /** Cloud REST base URL, e.g. https://api.letta.com */
  baseUrl: string;
  /** Bearer token (API key or OAuth access token). */
  token: string;
  /** Epoch ms — runs completed before this (minus a 5s margin) are ignored. */
  pollStartedAt: number;
  /** Run IDs already notified by the stream (dedup seed). */
  notifiedRunIds: string[];
  /** Poll interval in ms (default 20_000). */
  pollIntervalMs?: number;
  /** Notification avatar shape: "circle" (default), "squircle", or "square". */
  avatarShape?: string;
}

declare class BackgroundPollNativeModule {
  startPolling(options: {
    conversations: string; // JSON-encoded NativeConversationSpec[]
    baseUrl: string;
    token: string;
    pollStartedAt: number;
    notifiedRunIds: string[];
    pollIntervalMs?: number;
    avatarShape?: string;
  }): Promise<void>;
  stopPolling(): Promise<void>;
  armOneShot(specJson: string): Promise<boolean>;
  disarmOneShot(conversationId: string): Promise<void>;
  isOneShotArmed(conversationId: string): Promise<boolean>;
  setVisibleConversation(conversationId: string | null): Promise<void>;
  clearConversationNotifications(conversationId: string): Promise<void>;
}

const native = requireNativeModule<BackgroundPollNativeModule>("BackgroundPoll");

/** Start native polling for the given conversations. */
export function startPolling(options: NativePollOptions): Promise<void> {
  return native.startPolling({
    conversations: JSON.stringify(options.conversations),
    baseUrl: options.baseUrl,
    token: options.token,
    pollStartedAt: options.pollStartedAt,
    notifiedRunIds: options.notifiedRunIds,
    pollIntervalMs: options.pollIntervalMs,
    avatarShape: options.avatarShape,
  });
}

/** Stop native polling. */
export function stopPolling(): Promise<void> {
  return native.stopPolling();
}

/**
 * Incrementally arm a one-shot MOBILE_ONLY watch on the live poller
 * (send-time arm). Returns false when the poller isn't running — the
 * caller must fall back to a full startPolling with this spec included.
 */
export function armOneShot(spec: NativeConversationSpec): Promise<boolean> {
  return native.armOneShot(JSON.stringify(spec));
}

/** Disarm a one-shot watch (send failed — nothing to wait for). */
export function disarmOneShot(conversationId: string): Promise<void> {
  return native.disarmOneShot(conversationId);
}

/** True when the live poller still holds an armed one-shot for this conversation. */
export function isOneShotArmed(conversationId: string): Promise<boolean> {
  return native.isOneShotArmed(conversationId);
}

/** Suppress notifications for the conversation currently on screen. */
export function setVisibleConversation(conversationId: string | null): Promise<void> {
  return native.setVisibleConversation(conversationId);
}

/** Clear posted notifications for a conversation (user opened it). */
export function clearConversationNotifications(conversationId: string): Promise<void> {
  return native.clearConversationNotifications(conversationId);
}
