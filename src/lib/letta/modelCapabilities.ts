/**
 * Pure model-capability helpers — no react-native imports, so they stay
 * unit-testable in bun without the RN runtime.
 */

/**
 * True when the model's provider has an effort payload wired up at all
 * (openai/anthropic/z.ai family). Used to gate the effort chip: a record
 * carrying a stale tier from a previous model must not display against a
 * provider that can't send one.
 */
export function modelSupportsEffort(handle: string | null): boolean {
  if (!handle) return false;
  const provider = handle.includes("/") ? handle.split("/")[0] : undefined;
  return (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "zai" ||
    provider === "z-ai" ||
    provider === "lc-zai-coding"
  );
}
