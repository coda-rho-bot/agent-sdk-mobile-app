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
