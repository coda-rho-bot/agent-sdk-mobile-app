/**
 * Terminal-outcome classification for SDK result/error messages.
 *
 * SDK 0.8.39 terminal doctrine (docs/CLIENT-STRATEGY.md §Phase 1): the turn's
 * `result` frame is the only authority on how a turn ended. Socket closure is
 * NEVER a failure verdict — a stream that dies mid-turn leaves the outcome
 * unknown (the run may complete server-side), so `stream_closed` maps to a
 * recoverable-uncertainty state, not an error row. This module keeps that
 * classification pure so Phase 2 can lift it into @angus/letta-client-core
 * unchanged (same extraction pattern as echoMerge/grouping).
 */
import type { SDKErrorMessage, SDKResultMessage } from "@letta-ai/letta-agent-sdk/client";

/** How a terminal frame should present in the UI. */
export type TerminalOutcome =
  | { kind: "success" }
  /** The run genuinely failed — render the error with the detail offered. */
  | { kind: "failed"; detail: string }
  /** The transport died mid-turn; the outcome is unknown and recoverable.
   *  Render uncertainty (connection banner), never a failure row. */
  | { kind: "stream_lost"; detail: string };

/**
 * Classify a terminal `result` frame. `errorCode` is the canonical signal
 * (the `error` string is legacy); `recoverable` refines stream losses.
 */
export function classifyResult(message: SDKResultMessage): TerminalOutcome {
  if (message.success && message.stopReason !== "interrupted") return { kind: "success" };
  if (message.errorCode === "stream_closed" || message.recoverable === true) {
    return {
      kind: "stream_lost",
      detail: message.errorDetail ?? message.error ?? "Connection lost mid-turn.",
    };
  }
  return {
    kind: "failed",
    detail: message.errorDetail ?? message.error ?? "The run failed.",
  };
}

/**
 * Classify a bare `error` frame that arrives while a local turn is in flight.
 * Non-stream error frames are real failures; a stream_closed error means the
 * transport (not the run) died — the outcome stays unknown.
 */
export function classifyStreamError(message: SDKErrorMessage): TerminalOutcome {
  if (message.errorCode === "stream_closed" || message.recoverable === true) {
    return {
      kind: "stream_lost",
      detail: message.errorDetail ?? message.message ?? "Connection lost mid-turn.",
    };
  }
  return { kind: "failed", detail: message.message };
}
