/**
 * Bun-test virtual-module stubs for Expo/RN modules whose real packages load
 * react-native (Flow syntax — unparseable outside Metro) at MODULE SCOPE.
 *
 * Known offender: src/lib/auth/oauth.ts calls
 * `WebBrowser.maybeCompleteAuthSession()` at import time. bun:test's
 * `mock.module` does not intercept transitive static imports (bun 1.3.14),
 * so this uses a build plugin — register via `await import(...stubNativeModules)`
 * BEFORE importing any module whose graph reaches RN. bunfig.toml `preload`
 * would also work but changes behavior for every test file.
 */
import type { PluginBuilder } from "bun";

export const nativeStubsPlugin = {
  name: "stub-native-modules",
  setup(build: PluginBuilder): void {
    // expo-auth-session: oauth.ts imports PKCE helpers at module scope; the
    // real package reaches react-native (Flow syntax) through its peers.
    // Minimal surface for import-time: usePKCE + a discovery stub.
    build.module("expo-auth-session", () => ({
      exports: {
        usePKCE: (o?: { clientId?: string }) => ({ clientId: o?.clientId ?? null, challenge: null }),
        makeRedirectUri: () => "com.letta.mobile:/oauth",
        AuthSession: { getDefaultReturnUrl: () => "com.letta.mobile:/oauth" },
        startAsync: async () => ({ type: "dismiss" as const }),
      },
      loader: "object" as const,
    }));
    // expo-web-browser: only the module-scope maybeCompleteAuthSession() call
    // matters to importers under test; it is a no-op outside a browser window.
    build.module("expo-web-browser", () => ({
      exports: {
        maybeCompleteAuthSession: () => undefined,
        openAuthSessionAsync: async () => ({ type: "dismiss" as const }),
        dismissAuthSession: () => undefined,
      },
      loader: "object" as const,
    }));
    // The expo umbrella package: its entry (src/Expo.ts -> Expo.fx.tsx)
    // imports react-native (Flow syntax, unparseable outside Metro) at module
    // scope. Every expo-* leaf module resolves `expo` as a peer, so the
    // umbrella must be a virtual object for ANY expo-* module to load.
    build.module("expo", () => ({
      exports: {
        // Leaf modules import constants/helpers from the umbrella; provide the
        // common surface as no-op/empty values.
        default: {},
        Asset: class {},
        Constants: {},
        FileSystem: {},
        SQLite: {},
        Util: {},
      },
      loader: "object" as const,
    }));
    // expo-secure-store: SecureStore.getItemAsync etc. — backed by native
    // modules; tests that need storage inject their own persistence.
    build.module("expo-secure-store", () => ({
      exports: {
        getItemAsync: async () => null,
        setItemAsync: async () => undefined,
        deleteItemAsync: async () => undefined,
      },
      loader: "object" as const,
    }));
    // expo-image-manipulator / expo-image-picker: attachment pipelines call
    // these only when processing real images; identity-shaped stubs suffice
    // for import-time and reduce-path tests.
    build.module("expo-image-manipulator", () => ({
      exports: {
        manipulateAsync: async (uri: string) => ({ uri, width: 0, height: 0 }),
      },
      loader: "object" as const,
    }));
    build.module("expo-image-picker", () => ({
      exports: {
        launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
        launchCameraAsync: async () => ({ canceled: true, assets: [] }),
        requestMediaLibraryPermissionsAsync: async () => ({ granted: false }),
        requestCameraPermissionsAsync: async () => ({ granted: false }),
        MediaTypeOptions: { Images: "Images" },
      },
      loader: "object" as const,
    }));
  },
};

await Bun.plugin(nativeStubsPlugin);
