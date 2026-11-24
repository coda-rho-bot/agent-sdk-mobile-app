import { describe, expect, test } from "bun:test";

import { modelSupportsEffort } from "./modelCapabilities";

describe("modelSupportsEffort", () => {
  test("true for wired providers", () => {
    expect(modelSupportsEffort("openai/gpt-5.2")).toBe(true);
    expect(modelSupportsEffort("anthropic/claude-opus-4.5")).toBe(true);
    expect(modelSupportsEffort("lc-zai-coding/glm-5.3")).toBe(true);
    expect(modelSupportsEffort("zai/glm-5.3")).toBe(true);
    expect(modelSupportsEffort("z-ai/glm-5.3")).toBe(true);
  });

  test("false for providers without an effort payload", () => {
    expect(modelSupportsEffort("google/gemini-3-pro-preview")).toBe(false);
    expect(modelSupportsEffort("grok/whatever")).toBe(false);
  });

  test("false for null/blank handles", () => {
    expect(modelSupportsEffort(null)).toBe(false);
    expect(modelSupportsEffort("")).toBe(false);
  });
});
