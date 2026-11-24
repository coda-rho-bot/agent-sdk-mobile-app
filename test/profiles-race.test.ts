// ISOLATED TEST — runs in its own bun process (see package.json "test").
// This file's mock.module("../auth/oauthTokens") is process-global and
// irreversible in bun test: left inside src/, it silently replaces the real
// oauthTokens module for every other test file in the same run (bun test
// evaluates all files in one process). Moving it out + a second bun invocation
// keeps the pollution contained to this file.
import { expect, mock, test } from "bun:test";

const asyncStorage = new Map<string, string>();
const secureStorage = new Map<string, string>();

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => void asyncStorage.set(key, value),
    removeItem: async (key: string) => void asyncStorage.delete(key),
  },
}));

mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureStorage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void secureStorage.set(key, value),
  deleteItemAsync: async (key: string) => void secureStorage.delete(key),
}));

let finishRefresh: ((credential: OAuthCredential) => void) | undefined;
let signalRefreshStarted: (() => void) | undefined;
const refreshStarted = new Promise<void>((resolve) => {
  signalRefreshStarted = resolve;
});
const revokedRefreshTokens: string[] = [];

interface OAuthCredential {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

<<<<<<< HEAD:test/profiles-race.test.ts
mock.module("../src/lib/auth/oauthTokens", () => ({
=======
// bun's mock.module is PROCESS-GLOBAL: this replacement is visible to every
// later test file in the same run. Spread the REAL module's exports and
// override only what this file exercises — downstream importers (ChatSession's
// graph via api.ts, oauthTokens.test.ts) keep real behavior for the rest.
const realOAuthTokens = await import("../auth/oauthTokens");
mock.module("../auth/oauthTokens", () => ({
  ...realOAuthTokens,
  // Mocked behavior under test:
>>>>>>> 66c7e39a1faaa0bb4a8ffda929d96c7e6d14f960:src/lib/profiles/profiles.test.ts
  parseOAuthCredential: (value: string): OAuthCredential | null => {
    const parsed = JSON.parse(value) as OAuthCredential;
    return parsed.kind === "oauth" ? parsed : null;
  },
  refreshOAuthCredential: async (): Promise<OAuthCredential> => {
    signalRefreshStarted?.();
    return new Promise<OAuthCredential>((resolve) => {
      finishRefresh = resolve;
    });
  },
  revokeOAuthCredential: async (credential: OAuthCredential) => {
    revokedRefreshTokens.push(credential.refreshToken);
  },
}));

const { deleteProfile, getSecret } = await import("../src/lib/profiles/profiles");

test("profile deletion waits for refresh and revokes the rotated credential", async () => {
  const id = "profile-race";
  const key = `letta.secret.${id}`;
  secureStorage.set(
    key,
    JSON.stringify({
      kind: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now(),
    } satisfies OAuthCredential),
  );
  asyncStorage.set(
    "letta.profiles.v1",
    JSON.stringify([{ id, type: "cloud", name: "Cloud", url: "https://api.letta.com", createdAt: 1 }]),
  );

  const secret = getSecret(id);
  await refreshStarted;
  const deletion = deleteProfile(id);
  finishRefresh?.({
    kind: "oauth",
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: Date.now() + 3_600_000,
  });

  await expect(secret).resolves.toBe("new-access");
  await deletion;
  expect(revokedRefreshTokens).toEqual(["new-refresh"]);
  expect(secureStorage.has(key)).toBe(false);
});
