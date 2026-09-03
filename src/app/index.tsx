/**
 * Connect — the front door. Two connection-mode cards (Letta Cloud, your own
 * server) and the saved-profiles list. See docs/design-doc.md §4.1.
 *
 * Milestone 1 renders the full visual shell; profile storage and the live
 * test-connection flow arrive in milestone 3.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";

import { Dropdown } from "../components/ui/Dropdown";
import { Screen } from "../components/ui/Screen";
import { Sheet } from "../components/ui/Sheet";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { loadPinned, PINNED_PROFILES_KEY, togglePinned } from "../lib/favorites";
import { checkForUpdate, downloadUpdate, localVersion, type UpdateInfo } from "../lib/updateCheck";
import { Bloop } from "../components/ui/Bloop";
import {
  NotificationMode,
  loadAppDefault,
  saveAppDefault,
  resetAllAppDownstreamNotifications,
} from "../lib/notifications";
import {
  PermissionCascadeMode,
  type PermissionCascadeValue,
  permissionDetail,
  loadAppPermDefault,
  saveAppPermDefault,
  resetAllAppDownstream,
} from "../lib/permissions";
import { useTheme } from "../theme/ThemeProvider";
import { themeCatalog, themeNames } from "../theme/catalog";
import { brandMark, radius, space } from "../theme/tokens";

/**
 * The app's own mark: the same bloop the agents wear, so the icon, the avatars
 * and this screen are one idea. Placeholder art on purpose — fork this and
 * swap it for your own (docs/press/README.md).
 */
function Logomark({ size = 44 }: { size?: number; color?: string }) {
  return <Bloop id="bloop-app-mark" size={size} color={brandMark.bloop} />;
}

function ModeCard({
  glyph,
  title,
  detail,
  onPress,
}: {
  glyph: string;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
    >
      <View style={styles.cardRow}>
        <Text role="title" style={{ width: 32 }}>
          {glyph}
        </Text>
        <View style={styles.cardText}>
          <Text role="bodyEm">{title}</Text>
          <Text role="sub" ink={2}>
            {detail}
          </Text>
        </View>
        <Text role="title" ink={3}>
          ›
        </Text>
      </View>
    </Touchable>
  );
}

export default function ConnectScreen() {
  const theme = useTheme();
  const { colors } = theme;
  const [pinnedProfiles, setPinnedProfiles] = useState<Set<string>>(new Set());
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  useEffect(() => {
    void loadPinned(PINNED_PROFILES_KEY).then(setPinnedProfiles);
    // Side-loaded builds have no store — check the fork's latest release and
    // surface a banner when the installed APK is behind.
    void checkForUpdate().then(setUpdate);
  }, []);
  const manualCheck = () => {
    setChecking(true);
    setUpToDate(false);
    void checkForUpdate(true)
      .then((u) => {
        setUpdate(u);
        if (!u) setUpToDate(true);
      })
      .finally(() => setChecking(false));
  };

  const { profiles, activeProfile, setActive } = useProfiles();

  // App-level settings sheet — app-wide defaults + reset all downstream.
  const settingsRef = useRef<BottomSheetModal>(null);
  const [defaultPerm, setDefaultPerm] = useState<PermissionCascadeValue>(PermissionCascadeMode.STANDARD);
  const [appNotif, setAppNotif] = useState<NotificationMode>(NotificationMode.OFF);
  useEffect(() => {
    void loadAppPermDefault().then(setDefaultPerm);
    void loadAppDefault().then(setAppNotif);
  }, []);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}>
          <Touchable
            accessibilityLabel="App settings"
            accessibilityRole="button"
            onPress={() => settingsRef.current?.present()}
            style={styles.gear}
          >
            <Text role="title" ink={2}>
              ⚙
            </Text>
          </Touchable>
        </View>
        <View style={styles.hero}>
          <Logomark color={colors.ink} />
          <Text role="display" style={styles.heroTitle}>
            Chat with your agents,{"\n"}anywhere.
          </Text>
          <Text role="body" ink={2}>
            A reference client for the Letta Agent SDK.
          </Text>
        </View>

        {update ? (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Update available, version ${update.version}. Download the new build.`}
            onPress={() => void downloadUpdate(update)}
            style={[styles.updateBanner, { borderColor: colors.accent }]}
          >
            <Text role="sub" tone="accent">
              ⬆ Update available — v{update.version}
            </Text>
            <Text role="sub" ink={3}>
              Tap to download the latest build
            </Text>
          </Touchable>
        ) : null}
        <View style={styles.cards}>
          <ModeCard
            glyph="☁︎"
            title="Letta Cloud"
            detail="Sign in or use an API key"
            onPress={() => router.push({ pathname: "/profile", params: { type: "cloud" } })}
          />
          <ModeCard
            glyph="⌂"
            title="Your own server"
            detail="Connect over WebSocket"
            onPress={() => router.push({ pathname: "/profile", params: { type: "remote" } })}
          />
        </View>

        <View style={styles.saved}>
          <Text role="micro" ink={3}>
            Saved
          </Text>
          {profiles.length === 0 ? (
            <Text role="sub" ink={2} style={styles.savedEmpty}>
              Connections you save appear here.
            </Text>
          ) : (
            [...profiles].sort((a, b) => Number(pinnedProfiles.has(b.id)) - Number(pinnedProfiles.has(a.id))).map((profile) => (
              <Touchable
                key={profile.id}
                accessibilityRole="button"
                accessibilityLabel={`Connect with ${profile.name}`}
                onPress={async () => {
                  await setActive(profile.id);
                  router.push("/agents");
                }}
                onLongPress={() =>
                  router.push({ pathname: "/profile", params: { id: profile.id } })
                }
                scaleOnPress={false}
                style={styles.profileRow}
              >
                <View style={styles.profileInner}>
                  <StatusDot tone={profile.lastTest === "ok" ? "run" : profile.lastTest ? "danger" : "idle"} />
                  <View style={styles.profileText}>
                    <Text role="bodyEm">{profile.name}</Text>
                    <Text role="sub" ink={3}>
                      {profile.type === "cloud"
                        ? `Letta Cloud · ${profile.authMethod === "oauth" ? "signed in" : "API key"}`
                        : "Remote server"}
                      {activeProfile?.id === profile.id ? " · active" : ""}
                    </Text>
                  </View>
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={pinnedProfiles.has(profile.id) ? `Unpin ${profile.name}` : `Pin ${profile.name} to top`}
                    onPress={() => void togglePinned(PINNED_PROFILES_KEY, profile.id).then(setPinnedProfiles)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={styles.pinTouch}
                  >
                    <Text role="bodyEm" ink={pinnedProfiles.has(profile.id) ? 1 : 3}>
                      {pinnedProfiles.has(profile.id) ? "★" : "☆"}
                    </Text>
                  </Touchable>
                  <Text role="title" ink={3}>
                    ›
                  </Text>
                </View>
              </Touchable>
            ))
          )}
          {profiles.length > 0 ? (
            <Text role="sub" ink={3}>
              Long-press a connection to edit it.
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <Sheet ref={settingsRef} title="App defaults" scroll>
        <View style={styles.versionRow}>
          <Text role="sub" ink={3}>
            Agents Chat v{localVersion()}
          </Text>
          {update ? (
            <Touchable accessibilityRole="button" accessibilityLabel="Download update" onPress={() => void downloadUpdate(update)} style={styles.versionAction}>
              <Text role="sub" tone="accent">
                ⬆ v{update.version} — Download
              </Text>
            </Touchable>
          ) : (
            <Touchable accessibilityRole="button" accessibilityLabel="Check for updates" onPress={manualCheck} style={styles.versionAction}>
              <Text role="sub" tone="accent">
                {checking ? "Checking…" : upToDate ? "Up to date ✓" : "Check for updates"}
              </Text>
            </Touchable>
          )}
        </View>
        <Dropdown
          label="Permission mode"
          value={defaultPerm}
          options={[
            { value: PermissionCascadeMode.STRICT, label: "Strict", detail: "Every tool asks, even reads" },
            { value: PermissionCascadeMode.STANDARD, label: "Standard", detail: "Asks before risky tools" },
            { value: PermissionCascadeMode.ACCEPT_EDITS, label: "Accept edits", detail: "File edits are auto-approved" },
            { value: PermissionCascadeMode.UNRESTRICTED, label: "Unrestricted", detail: "Everything auto-approved", danger: true },
          ]}
          onSelect={(mode) => {
            setDefaultPerm(mode);
            void saveAppPermDefault(mode);
          }}
        />
        <Text role="sub" ink={3} style={styles.permHint}>
          App-wide default for permissions. Servers, agents, and conversations inherit this unless overridden.
        </Text>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Reset all downstream permission settings to app default"
          onPress={() =>
            Alert.alert(
              "Reset all permissions?",
              "Clears all server, agent, and conversation permission overrides. They will inherit from this app default.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Reset",
                  style: "destructive",
                  onPress: async () => {
                    await resetAllAppDownstream();
                    Alert.alert("Done", "All permission overrides cleared.");
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

        <View style={styles.sectionDivider} />

        <Dropdown
          label="Notification default"
          value={appNotif}
          options={[
            { value: NotificationMode.OFF, label: "Off", detail: "No notifications", danger: true },
            { value: NotificationMode.MOBILE_ONLY, label: "Mobile only", detail: "Runs started from this app" },
            { value: NotificationMode.ALL_MESSAGES, label: "All messages", detail: "All run completions" },
          ]}
          onSelect={(mode) => {
            setAppNotif(mode);
            void saveAppDefault(mode);
          }}
        />
        <Text role="sub" ink={3} style={styles.permHint}>
          App-wide default for notifications. Servers, agents, and conversations inherit this unless overridden.
        </Text>
        <View style={styles.sectionDivider} />

        <Text role="sub" ink={3}>
          Theme
        </Text>
        <View style={styles.themeGrid}>
          {Object.keys(themeCatalog)
            .sort((a, b) => (a === "angus" ? -1 : b === "angus" ? 1 : a.localeCompare(b)))
            .map((id) => {
              const entry = themeCatalog[id]!;
              const p = entry[theme.name] ?? entry.light ?? entry.dark!;
              const selected = theme.themeId === id;
              return (
                <Touchable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={`${themeNames[id] ?? id}${selected ? ". Selected" : ""}`}
                  onPress={() => theme.setThemeId(id)}
                  style={[
                    styles.themeSwatch,
                    { backgroundColor: p.surface, borderColor: selected ? p.accent : colors.surfaceEdge },
                  ]}
                >
                  <View style={[styles.themeDots, { backgroundColor: p.bg }]}>
                    <View style={[styles.themeDot, { backgroundColor: p.accent }]} />
                    <View style={[styles.themeDot, { backgroundColor: p.ink }]} />
                    <View style={[styles.themeDot, { backgroundColor: p.danger }]} />
                  </View>
                  <Text role="micro" ink={2} numberOfLines={1}>
                    {themeNames[id] ?? id}
                  </Text>
                </Touchable>
              );
            })}
        </View>

        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Reset all downstream notification settings to app default"
          onPress={() =>
            Alert.alert(
              "Reset all notifications?",
              "Clears all server, agent, and conversation notification overrides. They will inherit from this app default.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Reset",
                  style: "destructive",
                  onPress: async () => {
                    await resetAllAppDownstreamNotifications();
                    Alert.alert("Done", "All notification overrides cleared.");
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
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  versionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.sm,
  },
  versionAction: { paddingHorizontal: space.sm },
  themeGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingVertical: space.sm },
  themeSwatch: {
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.sm,
    alignItems: "center",
    gap: 6,
    minWidth: 76,
  },
  themeDots: {
    flexDirection: "row",
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  themeDot: { width: 12, height: 12, borderRadius: 999 },
  updateBanner: {
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2,
  },
  pinTouch: { paddingHorizontal: 6 },
  content: { paddingHorizontal: space.gutter, paddingBottom: space.xxl },
  topBar: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: space.sm },
  gear: { paddingHorizontal: space.sm },
  sectionDivider: { height: StyleSheet.hairlineWidth, marginVertical: space.md, backgroundColor: "transparent" },
  permHint: { paddingTop: space.md, fontStyle: "italic" },
  resetBtn: { paddingVertical: space.sm, alignItems: "center" },
  hero: { paddingTop: space.xxl, paddingBottom: space.section, gap: space.md },
  heroTitle: { marginTop: space.sm },
  cards: { gap: space.md },
  card: {
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
  },
  cardRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  cardText: { flex: 1, gap: 2 },
  saved: { paddingTop: space.section, gap: space.sm },
  savedEmpty: { paddingVertical: space.sm },
  profileRow: { marginHorizontal: -space.xs, paddingHorizontal: space.xs, borderRadius: radius.row },
  profileInner: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10 },
  profileText: { flex: 1, gap: 1 },
});
