import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@letta-ai/letta-agent-sdk/client";

// ChatSession's import graph reaches src/lib/auth/oauth.ts, whose module-scope
// `WebBrowser.maybeCompleteAuthSession()` loads react-native (Flow syntax —
// unparseable outside Metro). Register virtual-module stubs BEFORE the graph
// loads; ChatSession then comes in dynamically. See test/stubNativeModules.ts.
await import("../../../test/stubNativeModules");

const { ChatSession } = await import("./ChatSession");
const { emptyChat } = await import("./model");
const profile = { id: "test-profile", type: "cloud", name: "Test", url: "https://api.letta.com" } as unknown as
  Parameters<typeof ChatSession["open"]>[0]["profile"];

/**
 * Integration contract tests for SDK 0.8.39 terminal behavior as ChatSession
 * reduces it (docs/CLIENT-STRATEGY.md §Phase 1 acceptance):
 *  - a stream_closed terminal result settles the turn WITHOUT an error row
 *    (transport loss = recoverable uncertainty; the connection banner owns it)
 *  - an aborted turn settles via result with stopReason "interrupted"
 *  - a genuine failure still renders its error row
 *  - a mid-run stream_closed error frame does NOT render a failure row
 */

function session(): ChatSession {
  // open() fires hydration + permission restore against real transports —
  // construct directly for pure reducer tests instead.
  return new ChatSession({ profile, secret: "k" }, "conv-test", "agent-test");
}

function errorTexts(snapshot: { transcript: { kind: string; message?: string }[] }): string[] {
  return snapshot.transcript.filter((t) => t.kind === "error").map((t) => t.message ?? "");
}

describe("ChatSession terminal contract (SDK 0.8.39)", () => {
  test("stream_closed result settles the turn with NO error row and offline connection", () => {
    const s = session();
    const out = s.reduceForTest(
      { ...emptyChat, run: "running" },
      {
        type: "result",
        success: false,
        errorCode: "stream_closed",
        recoverable: true,
        error: "WebSocket closed unexpectedly",
      } satisfies SDKMessage,
    );
    expect(out.run).toBe("idle");
    expect(out.connection).toBe("offline");
    expect(errorTexts(out)).toEqual([]);
  });

  test("genuine failure result renders its error detail", () => {
    const s = session();
    const out = s.reduceForTest(
      { ...emptyChat, run: "running" },
      {
        type: "result",
        success: false,
        errorCode: "llm_api_error",
        errorDetail: "provider 500",
      } satisfies SDKMessage,
    );
    expect(out.run).toBe("idle");
    expect(errorTexts(out)).toEqual(["provider 500"]);
  });

  test("aborted turn settles via interrupted result and stays distinct from stream loss", () => {
    const s = session();
    const out = s.reduceForTest(
      { ...emptyChat, run: "aborting" },
      { type: "result", success: false, stopReason: "interrupted" } satisfies SDKMessage,
    );
    expect(out.run).toBe("idle");
    // Abort is a user action, not transport loss: connection stays as-was
    // (never flips offline), and the interrupted row treatment comes via
    // interruptedKey. Legacy behavior renders a terminal row for an
    // interrupted stop with no settled message — preserved here.
    expect(out.connection).not.toBe("offline");
  });

  test("mid-run stream_closed error frame marks offline, no error row", () => {
    const s = session();
    const out = s.reduceForTest(
      { ...emptyChat, run: "running" },
      {
        type: "error",
        message: "socket died",
        errorCode: "stream_closed",
        recoverable: true,
        stopReason: "stream_closed",
      } satisfies SDKMessage,
    );
    expect(out.connection).toBe("offline");
    expect(errorTexts(out)).toEqual([]);
  });

  test("non-transport error frame still renders its message", () => {
    const s = session();
    const out = s.reduceForTest(
      { ...emptyChat, run: "running" },
      { type: "error", message: "approval_conflict", stopReason: "error" } satisfies SDKMessage,
    );
    expect(errorTexts(out)).toEqual(["approval_conflict"]);
  });

  test("successful result returns to idle with no error", () => {
    const s = session();
    const out = s.reduceForTest({ ...emptyChat, run: "running" }, { type: "result", success: true } satisfies SDKMessage);
    expect(out.run).toBe("idle");
    expect(errorTexts(out)).toEqual([]);
  });
});
