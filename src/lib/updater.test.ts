import { describe, expect, test } from "bun:test";
import { compareVersions, isUpdateAvailable } from "./version";

describe("compareVersions", () => {
  test("patch ordering", () => {
    expect(compareVersions("0.3.3", "0.3.2")).toBeGreaterThan(0);
    expect(compareVersions("0.3.2", "0.3.3")).toBeLessThan(0);
    expect(compareVersions("0.3.2", "0.3.2")).toBe(0);
  });

  test("minor ordering", () => {
    expect(compareVersions("0.4.0", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  test("major ordering dominates", () => {
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  test("missing segments treated as zero", () => {
    expect(compareVersions("0.4", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("1", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
  });

  test("suffixed versions compare without NaN (mixed shapes)", () => {
    // The trap (Uncia, PR #8): Number("0-ls") is NaN; NaN !== 0 returns
    // falsy NaN → a NEWER suffixed remote read as not-newer against a
    // plain local. These must all produce real numbers.
    expect(compareVersions("0.4.1-ls.1", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.1", "0.4.0-ls.1")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0-ls.1", "0.4.0-ls.1")).toBe(0);
    expect(compareVersions("0.5.0-ls.1", "0.4.0-ls.1")).toBeGreaterThan(0);
    // Rollback protection across shapes: older is older, suffixed or not.
    expect(compareVersions("0.3.11", "0.4.0-ls.1")).toBeLessThan(0);
    expect(compareVersions("0.4.0", "0.4.1-ls.1")).toBeLessThan(0);
  });
});

describe("isUpdateAvailable", () => {
  const m = (version: string) => ({
    version,
    versionCode: 1,
    apk: "https://example.com/a.apk",
    size: 1,
    releasedAt: "",
  });

  test("newer manifest is an update", () => {
    expect(isUpdateAvailable(m("0.4.0"), "0.3.2")).toBe(true);
  });

  test("same version is not an update", () => {
    expect(isUpdateAvailable(m("0.3.2"), "0.3.2")).toBe(false);
  });

  test("older manifest is not an update (rollback protection)", () => {
    expect(isUpdateAvailable(m("0.2.0"), "0.3.2")).toBe(false);
  });
});
