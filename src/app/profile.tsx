/**
 * Profile editor — Letta Cloud offers browser OAuth or an API key. Remote
 * app-servers keep their WebSocket URL + capability token flow.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { Bloop } from "../components/ui/Bloop";
import { Header, Screen } from "../components/ui/Screen";
import { Dropdown } from "../components/ui/Dropdown";
import { Sheet } from "../components/ui/Sheet";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { OAuthCancelledError, signInWithLetta } from "../lib/auth/oauth";
import { testConnection, type TestResult } from "../lib/letta/testConnection";
import {
  CLOUD_DEFAULT_URL,
  hasSecret,
  newProfileId,
  saveOAuthProfile,
  saveProfile,
  type CloudAuthMethod,
  type Profile,
  type ProfileType,
} from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import {
  NotificationMode,
  labelWithResolution,
  loadServerSetting,
  saveServerSetting,
  loadAppDefault,
  resolveMode,
  resetServerDownstreamNotifications,
} from "../lib/notifications";
import {
  PermissionCascadeMode,
  type PermissionCascadeValue,
  permLabelWithResolution,
  permissionDetail,
  loadServerPerm,
  saveServerPerm,
  loadAppPermDefault,
  resolvePermission,
  resetServerDownstreamPermissions,
} from "../lib/permissions";
import { listAgents } from "../lib/letta/api";
import { getSecret } from "../lib/profiles/profiles";
import { useTheme } from "../theme/ThemeProvider";
import { brandMark, radius, space } from "../theme/tokens";

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  hasStoredSecret,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  secret?: boolean;
  hasStoredSecret?: boolean;
  autoFocus?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text role="micro" ink={3}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={hasStoredSecret && secret ? "•••••••• (stored — type to replace)" : placeholder}
        placeholderTextColor={colors.ink3}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        style={[
          styles.input,
          {
            color: colors.ink,
            borderColor: colors.surfaceEdge,
            backgroundColor: colors.surface,
          },
        ]}
      />
    </View>
  );
}

function AuthChoice({
  selected,
  title,
  detail,
  onPress,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Touchable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={[
        styles.authChoice,
        {
          backgroundColor: colors.surface,
          borderColor: selected ? colors.accent : colors.surfaceEdge,
        },
      ]}
    >
      <View style={styles.authChoiceText}>
        <Text role="bodyEm">{title}</Text>
        <Text role="sub" ink={2}>
          {detail}
        </Text>
      </View>
      <View
        style={[
          styles.radio,
          {
            borderColor: selected ? colors.accent : colors.ink3,
            backgroundColor: selected ? colors.accent : "transparent",
          },
        ]}
      >
        {selected ? <View style={[styles.radioCenter, { backgroundColor: colors.surface }]} /> : null}
      </View>
    </Touchable>
  );
}

export default function ProfileEditorScreen() {
  const params = useLocalSearchParams<{ type?: ProfileType; id?: string }>();
  const { colors } = useTheme();
  const { profiles, refresh, setActive } = useProfiles();

  const existing = params.id ? profiles.find((profile) => profile.id === params.id) : undefined;
  const type: ProfileType = existing?.type ?? (params.type === "remote" ? "remote" : "cloud");
  const existingAuthMethod: CloudAuthMethod = existing?.authMethod ?? "api_key";

  const [authMethod, setAuthMethod] = useState<CloudAuthMethod>(
    existing ? existingAuthMethod : type === "remote" ? "api_key" : "oauth",
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [secret, setSecret] = useState("");
  const [storedSecret, setStoredSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [oauthWorking, setOAuthWorking] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Server-level settings sheet (only for existing profiles).
  const serverSettingsRef = useRef<BottomSheetModal>(null);

  // Server-level notification default (only for existing profiles).
  const [serverNotif, setServerNotif] = useState<NotificationMode>(NotificationMode.APP_DEFAULT);
  const [serverNotifResolved, setServerNotifResolved] = useState<NotificationMode>(NotificationMode.OFF);

  // Server-level permission default (only for existing profiles).
  const [serverPerm, setServerPerm] = useState<PermissionCascadeValue>(PermissionCascadeMode.APP_DEFAULT);
  const [serverPermResolved, setServerPermResolved] = useState<PermissionCascadeValue>(PermissionCascadeMode.STANDARD);

  useEffect(() => {
    if (existing) void hasSecret(existing.id).then(setStoredSecret);
    if (existing) {
      void (async () => {
        const [serverNotifSetting, appNotifSetting, serverPermSetting, appPermSetting] = await Promise.all([
          loadServerSetting(existing.id),
          loadAppDefault(),
          loadServerPerm(existing.id),
          loadAppPermDefault(),
        ]);
        setServerNotif(serverNotifSetting);
        setServerNotifResolved(resolveMode(NotificationMode.APP_DEFAULT, serverNotifSetting, appNotifSetting, appNotifSetting));
        setServerPerm(serverPermSetting);
        setServerPermResolved(resolvePermission(PermissionCascadeMode.APP_DEFAULT, PermissionCascadeMode.AGENT_DEFAULT, serverPermSetting, appPermSetting));
      })();
    }
  }, [existing]);

  const storedSecretMatches =
    storedSecret && (type === "remote" || existingAuthMethod === authMethod);
  const effectiveUrl = type === "cloud" ? CLOUD_DEFAULT_URL : url.trim();
  const canTest =
    (type === "remote" || authMethod === "api_key") &&
    effectiveUrl.length > 0 &&
    (secret.length > 0 || storedSecretMatches) &&
    !testing;
  const canSave = result?.ok === true || (existing !== undefined && storedSecretMatches);

  const chooseAuthMethod = (next: CloudAuthMethod) => {
    setAuthMethod(next);
    setSecret("");
    setResult(null);
    setMessage(null);
  };

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    setMessage(null);
    let effectiveSecret = secret;
    if (!effectiveSecret && existing && storedSecretMatches) {
      const { getSecret } = await import("../lib/profiles/profiles");
      effectiveSecret = (await getSecret(existing.id)) ?? "";
    }
    const verdict = await testConnection(type, effectiveUrl, effectiveSecret);
    setResult(verdict);
    setTesting(false);
  };

  const finishSave = async (profile: Profile) => {
    await setActive(profile.id);
    await refresh();
    router.replace("/agents");
  };

  const runOAuth = async () => {
    setOAuthWorking(true);
    setResult(null);
    setMessage("Opening Letta in your browser…");
    try {
      const credential = await signInWithLetta();
      setMessage("Checking your Letta account…");
      const verdict = await testConnection("cloud", CLOUD_DEFAULT_URL, credential.accessToken);
      if (!verdict.ok) {
        setResult(verdict);
        setMessage(null);
        return;
      }
      const profile: Profile = {
        id: existing?.id ?? newProfileId(),
        type: "cloud",
        authMethod: "oauth",
        name: name.trim() || existing?.name || "Letta Cloud",
        url: CLOUD_DEFAULT_URL,
        lastTest: "ok",
        createdAt: existing?.createdAt ?? Date.now(),
      };
      await saveOAuthProfile(profile, credential);
      await finishSave(profile);
    } catch (error) {
      setMessage(
        error instanceof OAuthCancelledError
          ? "Sign-in was cancelled."
          : error instanceof Error
            ? error.message
            : "Letta Cloud could not complete sign-in.",
      );
    } finally {
      setOAuthWorking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    const profile: Profile = {
      id: existing?.id ?? newProfileId(),
      type,
      name: name.trim() || (type === "cloud" ? "Letta Cloud" : "My server"),
      url: effectiveUrl,
      ...(type === "cloud" ? { authMethod: "api_key" as const } : {}),
      lastTest: result
        ? result.ok
          ? "ok"
          : result.reason === "unauthorized"
            ? "unauthorized"
            : "unreachable"
        : existing?.lastTest,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await saveProfile(profile, secret || null);
    await finishSave(profile);
    setSaving(false);
  };

  return (
    <Screen>
      <Header
        title={type === "cloud" ? "Letta Cloud" : "Your own server"}
        back
        trailing={
          existing ? (
            <Touchable
              accessibilityLabel="Server settings"
              accessibilityRole="button"
              onPress={() => serverSettingsRef.current?.present()}
              style={styles.gear}
            >
              <Text role="title" ink={2}>
                ⚙
              </Text>
            </Touchable>
          ) : undefined
        }
      />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {type === "cloud" ? (
            <>
              <View style={styles.cloudIntro}>
                <Bloop id="cloud-auth" size={52} color={brandMark.bloop} />
                <View style={styles.cloudIntroText}>
                  <Text role="title">Connect to Letta Cloud</Text>
                  <Text role="body" ink={2}>
                    Choose how you want to sign in.
                  </Text>
                </View>
              </View>

              <View accessibilityRole="radiogroup" style={styles.authChoices}>
                <AuthChoice
                  selected={authMethod === "oauth"}
                  title="Continue with Letta"
                  detail="Sign in securely in your browser"
                  onPress={() => chooseAuthMethod("oauth")}
                />
                <AuthChoice
                  selected={authMethod === "api_key"}
                  title="Use an API key"
                  detail="Paste a key from your Letta account"
                  onPress={() => chooseAuthMethod("api_key")}
                />
              </View>

              {authMethod === "oauth" ? (
                <View style={styles.oauthPanel}>
                  <Field
                    label="Connection name"
                    value={name}
                    onChange={setName}
                    placeholder="Letta Cloud"
                  />
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={existing?.authMethod === "oauth" ? "Sign in again" : "Continue with Letta"}
                    disabled={oauthWorking}
                    onPress={runOAuth}
                    style={[
                      styles.primary,
                      { backgroundColor: colors.accent, opacity: oauthWorking ? 0.6 : 1 },
                    ]}
                  >
                    <Text role="bodyEm" style={styles.primaryLabel}>
                      {oauthWorking
                        ? "Waiting for browser…"
                        : existing?.authMethod === "oauth"
                          ? "Sign in again"
                          : "Continue with Letta"}
                    </Text>
                  </Touchable>
                  <Text role="sub" ink={2} style={styles.centeredText}>
                    Your browser handles sign-in. This app receives a revocable access token, not your password.
                  </Text>
                </View>
              ) : (
                <View style={styles.apiKeyPanel}>
                  <Field
                    label="Connection name"
                    value={name}
                    onChange={setName}
                    placeholder="Personal Cloud"
                    autoFocus={!existing}
                  />
                  <Field
                    label="API key"
                    value={secret}
                    onChange={(value) => {
                      setSecret(value);
                      setResult(null);
                    }}
                    placeholder="sk-…"
                    secret
                    hasStoredSecret={storedSecretMatches}
                  />
                  <Text role="sub" ink={2}>
                    Your key stays in the device keychain and is sent only to Letta Cloud.
                  </Text>
                </View>
              )}
            </>
          ) : (
            <>
              <Field
                label="Name"
                value={name}
                onChange={setName}
                placeholder="Homeserver"
                autoFocus={!existing}
              />
              <Field
                label="WebSocket URL"
                value={url}
                onChange={setUrl}
                placeholder="wss://your-server:4500"
              />
              <Field
                label="Capability token"
                value={secret}
                onChange={(value) => {
                  setSecret(value);
                  setResult(null);
                }}
                placeholder="token"
                secret
                hasStoredSecret={storedSecretMatches}
              />
              <Text role="sub" ink={2}>
                A remote server can run tools on that machine. Prefer wss:// or a private network like
                Tailscale; plain ws:// is for development.
              </Text>
            </>
          )}

          {message ? (
            <Text role="sub" ink={2} accessibilityLiveRegion="polite" style={styles.centeredText}>
              {message}
            </Text>
          ) : null}
          {result ? (
            <Text role="sub" tone={result.ok ? "run" : "danger"} accessibilityLiveRegion="polite">
              {result.detail}
            </Text>
          ) : null}

          {(type === "remote" || authMethod === "api_key") && (
            <>
              <View style={styles.actions}>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel="Test connection"
                  disabled={!canTest}
                  onPress={runTest}
                  style={[
                    styles.test,
                    { borderColor: colors.surfaceEdge, opacity: canTest ? 1 : 0.5 },
                  ]}
                >
                  <Text role="bodyEm" tone="accent" style={styles.actionLabel}>
                    {testing ? "Testing…" : "Test connection"}
                  </Text>
                </Touchable>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel="Save"
                  disabled={!canSave || saving}
                  onPress={save}
                  style={[
                    styles.save,
                    {
                      backgroundColor: colors.accent,
                      opacity: canSave && !saving ? 1 : 0.5,
                    },
                  ]}
                >
                  <Text role="bodyEm" style={[styles.actionLabel, styles.primaryLabel]}>
                    {saving ? "Saving…" : "Save"}
                  </Text>
                </Touchable>
              </View>
              {!result?.ok && !existing ? (
                <Text role="sub" ink={3} style={styles.centeredText}>
                  Run a successful test to enable Save.
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {existing ? (
        <Sheet ref={serverSettingsRef} title="Server settings" scroll>
          <Dropdown
            label="Notification default"
            value={serverNotif}
            options={
              (
                [
                  NotificationMode.OFF,
                  NotificationMode.MOBILE_ONLY,
                  NotificationMode.ALL_MESSAGES,
                  NotificationMode.APP_DEFAULT,
                ] as NotificationMode[]
              ).map((option) => ({
                value: option,
                label: labelWithResolution(option, serverNotifResolved),
                danger: option === NotificationMode.OFF,
              }))
            }
            onSelect={(option) => {
              setServerNotif(option);
              setServerNotifResolved(resolveMode(option, serverNotif, serverNotifResolved, serverNotifResolved));
              void saveServerSetting(existing.id, option);
            }}
          />
          <Text role="sub" ink={3} style={styles.permHint}>
            Default for all agents on this connection. Individual agents and conversations can override.
          </Text>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Reset all downstream notification settings to server default"
            onPress={() =>
              Alert.alert(
                "Reset notifications?",
                "Clears all agent and conversation notification overrides for this connection. They will inherit from the app default.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Reset",
                    style: "destructive",
                    onPress: async () => {
                      try {
                        const secret = (await getSecret(existing.id)) ?? "";
                        const agents = await listAgents({ profile: existing, secret });
                        await resetServerDownstreamNotifications(agents.map((a) => a.id));
                        Alert.alert("Done", "All notification overrides for this connection cleared.");
                      } catch (e) {
                        Alert.alert("Couldn't reset", e instanceof Error ? e.message : undefined);
                      }
                    },
                  },
                ],
              )
            }
            style={styles.resetBtn}
          >
            <Text role="body" tone="danger">
              Reset all downstream notifications
            </Text>
          </Touchable>

          <View style={styles.sectionDivider} />

          <Dropdown
            label="Permission default"
            value={serverPerm}
            options={
              (
                [
                  PermissionCascadeMode.STRICT,
                  PermissionCascadeMode.STANDARD,
                  PermissionCascadeMode.ACCEPT_EDITS,
                  PermissionCascadeMode.UNRESTRICTED,
                  PermissionCascadeMode.APP_DEFAULT,
                ] as PermissionCascadeValue[]
              ).map((option) => ({
                value: option,
                label: permLabelWithResolution(option, serverPermResolved),
                detail: permissionDetail(option),
                danger: option === PermissionCascadeMode.UNRESTRICTED,
              }))
            }
            onSelect={(option) => {
              setServerPerm(option);
              setServerPermResolved(resolvePermission(option, PermissionCascadeMode.AGENT_DEFAULT, serverPerm, serverPermResolved));
              void saveServerPerm(existing.id, option);
            }}
          />
          <Text role="sub" ink={3} style={styles.permHint}>
            Default for all agents on this connection. Individual agents and conversations can override.
          </Text>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Reset all downstream permission settings to server default"
            onPress={() =>
              Alert.alert(
                "Reset permissions?",
                "Clears all agent and conversation permission overrides for this connection. They will inherit from the app default.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Reset",
                    style: "destructive",
                    onPress: async () => {
                      try {
                        const secret = (await getSecret(existing.id)) ?? "";
                        const agents = await listAgents({ profile: existing, secret });
                        await resetServerDownstreamPermissions(agents.map((a) => a.id));
                        Alert.alert("Done", "All permission overrides for this connection cleared.");
                      } catch (e) {
                        Alert.alert("Couldn't reset", e instanceof Error ? e.message : undefined);
                      }
                    },
                  },
                ],
              )
            }
            style={styles.resetBtn}
          >
            <Text role="body" tone="danger">
              Reset all downstream permissions
            </Text>
          </Touchable>
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: space.gutter,
    paddingTop: space.sm,
    gap: space.lg,
    paddingBottom: space.xxl,
  },
  cloudIntro: { flexDirection: "row", alignItems: "center", gap: space.lg, paddingVertical: space.sm },
  cloudIntroText: { flex: 1, gap: space.xs },
  authChoices: { gap: space.sm },
  authChoice: {
    minHeight: 76,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  authChoiceText: { flex: 1, gap: 2 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  radioCenter: { width: 7, height: 7, borderRadius: 4 },
  oauthPanel: { gap: space.md, paddingTop: space.sm },
  apiKeyPanel: { gap: space.lg, paddingTop: space.sm },
  field: { gap: 6 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  primary: { borderRadius: radius.row, alignItems: "center" },
  primaryLabel: { color: "#FFFFFF", paddingVertical: 14 },
  centeredText: { textAlign: "center" },
  actions: { flexDirection: "row", gap: space.md, paddingTop: space.sm },
  test: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    alignItems: "center",
  },
  save: { flex: 1, borderRadius: radius.row, alignItems: "center" },
  actionLabel: { paddingVertical: 13 },
  gear: { paddingHorizontal: space.sm, marginRight: space.xs },
  permHint: { paddingTop: space.md, fontStyle: "italic" },
  resetBtn: { paddingVertical: space.sm, alignItems: "center" },
  sectionLabel: { paddingTop: space.sm, paddingBottom: 2 },
  sectionDivider: { height: StyleSheet.hairlineWidth, marginVertical: space.md, backgroundColor: "transparent" },
});
