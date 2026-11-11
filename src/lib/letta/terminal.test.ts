import { describe, expect, test } from "bun:test";

import type { SDKErrorMessage, SDKResultMessage } from "@letta-ai/letta-agent-sdk/client";

import { classifyResult, classifyStreamError } from "./terminal";

/**
 * Contract tests for SDK 0.8.39 terminal doctrine (docs/CLIENT-STRATEGY.md
 * §Phase 1): read through the terminal `result`, prefer `result.errorCode`,
 * and never infer failure from socket closure — transport loss is a
 * recoverable stream_closed uncertainty, not a failed run.
 */

function result(overrides: Partial<SDKResultMessage>): SDKResultMessage {
  return { type: "result", success: true, ...overrides };
}

function streamError(overrides: Partial<SDKErrorMessage>): SDKErrorMessage {
  return { type: "error", message: "boom", stopReason: "error", ...overrides };
}

describe("classifyResult", () => {
  test("a successful result is success", () => {
    expect(classifyResult(result({ success: true }))).toEqual({ kind: "success" });
  });

  test("a genuine failure is failed with detail from errorDetail", () => {
    const outcome = classifyResult(
      result({ success: false, errorDetail: "llm exploded", errorCode: "llm_api_error" }),
    );
    expect(outcome).toEqual({ kind: "failed", detail: "llm exploded" });
  });

  test("failure detail falls back to legacy error string, then a default", () => {
    expect(classifyResult(result({ success: false, error: "legacy msg" }))).toEqual({
      kind: "failed",
      detail: "legacy msg",
    });
    expect(classifyResult(result({ success: false }))).toEqual({
      kind: "failed",
      detail: "The run failed.",
    });
  });

  test("socket closure mid-turn is stream_lost, NEVER failed (canonical case)", () => {
    // 0.8.39's closeWithError(): transport death with a turn active fails the
    // turn with errorCode "stream_closed" + recoverable. The run may still
    // complete server-side — the outcome is unknown, not failed.
    const outcome = classifyResult(
      result({
        success: false,
        errorCode: "stream_closed",
        recoverable: true,
        error: "WebSocket closed",
      }),
    );
    expect(outcome.kind).toBe("stream_lost");
  });

  test("recoverable without an explicit code still reads as stream_lost", () => {
    // The SDK marks transport-class failures recoverable even when the code
    // is generic — the uncertainty classification keys off recoverable too.
    const outcome = classifyResult(result({ success: false, recoverable: true, error: "net" }));
    expect(outcome.kind).toBe("stream_lost");
  });

  test("stream_lost carries the best detail available", () => {
    const outcome = classifyResult(
      result({
        success: false,
        errorCode: "stream_closed",
        recoverable: true,
        errorDetail: "socket dropped mid-stream",
      }),
    );
    expect(outcome).toEqual({ kind: "stream_lost", detail: "socket dropped mid-stream" });
  });

  test("an interrupted (aborted) turn is a plain failure-shaped stop, not stream loss", () => {
    // User abort: stopReason "interrupted", success false, NOT recoverable —
    // the app renders its "Stopped" treatment via interruptedKey.
    const outcome = classifyResult(result({ success: false, stopReason: "interrupted" }));
    expect(outcome.kind).toBe("failed");
  });

  test("the new structured_output_error code classifies as a normal failure", () => {
    // 0.8.39 addition: schema-validated output failed — a genuine failure.
    const outcome = classifyResult(
      result({ success: false, errorCode: "structured_output_error", errorDetail: "schema mismatch" }),
    );
    expect(outcome).toEqual({ kind: "failed", detail: "schema mismatch" });
  });
});

describe("classifyStreamError", () => {
  test("a mid-run transport error frame is stream_lost", () => {
    const outcome = classifyStreamError(
      streamError({ errorCode: "stream_closed", recoverable: true, message: "ws closed" }),
    );
    expect(outcome.kind).toBe("stream_lost");
  });

  test("a real error frame is failed", () => {
    const outcome = classifyStreamError(streamError({ message: "approval_conflict" }));
    expect(outcome).toEqual({ kind: "failed", detail: "approval_conflict" });
  });
});
