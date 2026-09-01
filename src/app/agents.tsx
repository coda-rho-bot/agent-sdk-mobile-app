/**
 * Agents — live agent list for the active connection, with create and
 * rename/delete. Cloud lists via REST, remote via protocol `agent_list`;
 * creation goes through the Agent SDK client (docs/design-doc.md §4.2,
 * Appendix A).
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, TextInput, View } from "react-native";

import { Bloop } from "../components/ui/Bloop";
import { Dropdown } from "../components/ui/Dropdown";
import { EmptyState } from "../components/ui/EmptyState";
import { Header, Screen } from "../components/ui/Screen";
import { Sheet } from "../components/ui/Sheet";
import { SkeletonList } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Image } from "expo-image";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Touchable } from "../components/ui/Touchable";
import { ModelSheet } from "../components/chat/ModelSheet";
import { haptic } from "../lib/haptics";
import {
  applyModelToConversations,
  createAgent,
  deleteAgent,
  fetchAgentProfilePicture,
  fetchRunActivity,
  listAgents,
  listConversations,
  listModels,
  updateAgent,
  type AgentSummary,
  type ModelOption,
} from "../lib/letta/api";
import { getSecret, type Profile } from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { radius, space } from "../theme/tokens";
import {
  NotificationMode,
  labelWithResolution,
  loadAppDefault,
  loadServerSetting,
  saveServerSetting,
  resolveMode,
  resetServerDownstreamNotifications,
} from "../lib/notifications";
import {
  PermissionCascadeMode,
  type PermissionCascadeValue,
  permLabelWithResolution,
  permissionDetail,
  loadAppPermDefault,
  loadServerPerm,
  saveServerPerm,
  resolvePermission,
  resetServerDownstreamPermissions,
} from "../lib/permissions";

function relativeTime(iso?: string): string {
  if (!iso) return "no activity yet";
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Strip the provider prefix for display: "anthropic/claude-x" → "claude-x". */
function shortModel(model: string): string {
  return model.includes("/") ? model.split("/").slice(1).join("/") : model;
}

function AgentRow({
  agent,
  avatarUrl,
  running,
  onPress,
  onLongPress,
}: {
  agent: AgentSummary;
  avatarUrl?: string;
  running?: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}, ${shortModel(agent.model)}, active ${relativeTime(agent.lastActive)}`}
      onPress={onPress}
      onLongPress={onLongPress}
      scaleOnPress={false}
      style={styles.row}
    >
      <View style={styles.rowInner}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatar} contentFit="cover" transition={150} />
        ) : (
          <Bloop id={agent.id} />
        )}
        <View style={styles.rowText}>
          <Text role="bodyEm" numberOfLines={1}>
            {agent.name}
          </Text>
          <View style={styles.meta}>
            {running ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : null}
            <Text role="sub" ink={2} numberOfLines={1} style={{ flex: 1 }}>
              {agent.description?.trim() || shortModel(agent.model)}
            </Text>
            <Text role="sub" ink={3}>
              · {relativeTime(agent.lastActive)}
            </Text>
          </View>
        </View>
      </View>
      <View style={[styles.divider, { backgroundColor: colors.surfaceEdge }]} />
    </Touchable>
  );
}

/**
 * Profile-picture cache: AsyncStorage key per agent holds the fetched data
 * URL + the MemFS commit it came from. A changed commit re-fetches; the same
 * commit keeps the cached image (avoids re-downloading on every visit).
 */
const AVATAR_CACHE_PREFIX = "letta.avatar.";

/**
 * Cache-first: a stored avatar renders instantly, then a background request
 * validates the MemFS commit — the image is only re-downloaded when the
 * commit changed. Returns the cache hit immediately (null = nothing cached
 * and/or nothing on the server — the caller falls back to the Bloop mark).
 */
async function loadAgentAvatar(
  conn: { profile: Profile; secret: string },
  agentId: string,
): Promise<string | null> {
  let cachedDataUrl: string | null = null;
  try {
    const cached = await AsyncStorage.getItem(AVATAR_CACHE_PREFIX + agentId);
    if (cached) {
      const parsed = JSON.parse(cached) as { dataUrl?: string };
      if (parsed.dataUrl) cachedDataUrl = parsed.dataUrl;
    }
  } catch {
    // Cache read failure is invisible — fall through to the network.
  }
  const fresh = await fetchAgentProfilePicture(conn, agentId);
  if (!fresh) return cachedDataUrl;
  if (cachedDataUrl) {
    try {
      const cached = await AsyncStorage.getItem(AVATAR_CACHE_PREFIX + agentId);
      const parsed = cached ? (JSON.parse(cached) as { commitSha?: string | null }) : null;
      if (parsed && parsed.commitSha === fresh.commitSha) return cachedDataUrl;
    } catch {
      // fall through — refresh the cache
    }
  }
  try {
    await AsyncStorage.setItem(AVATAR_CACHE_PREFIX + agentId, JSON.stringify(fresh));
  } catch {
    // Cache write failure is invisible too — the image still renders.
  }
  return fresh.dataUrl;
}

export default function AgentsScreen() {
  const { colors } = useTheme();
  const { activeProfile } = useProfiles();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [runningAgents, setRunningAgents] = useState<Set<string>>(new Set());

  // Create/edit sheet state.
  const sheetRef = useRef<BottomSheetModal>(null);
  const [editing, setEditing] = useState<AgentSummary | null>(null);
  const [draftName, setDraftName] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Server settings sheet state — server-level notification + permission
  // defaults, plus a reset that clears agent-level overrides under this server.
  const settingsRef = useRef<BottomSheetModal>(null);
  const [serverNotif, setServerNotif] = useState<NotificationMode>(NotificationMode.APP_DEFAULT);
  const [serverNotifApp, setServerNotifApp] = useState<NotificationMode>(NotificationMode.OFF);
  const [serverNotifResolved, setServerNotifResolved] = useState<NotificationMode>(NotificationMode.OFF);
  const [serverPerm, setServerPerm] = useState<PermissionCascadeValue>(PermissionCascadeMode.APP_DEFAULT);
  const [serverPermApp, setServerPermApp] = useState<PermissionCascadeValue>(PermissionCascadeMode.STANDARD);
  const [serverPermResolved, setServerPermResolved] = useState<PermissionCascadeValue>(PermissionCascadeMode.STANDARD);

  const refreshServerSettings = useCallback(async (profile: NonNullable<typeof activeProfile>) => {
    const [notifSetting, notifApp, permSetting, permApp] = await Promise.all([
      loadServerSetting(profile.id),
      loadAppDefault(),
      loadServerPerm(profile.id),
      loadAppPermDefault(),
    ]);
    setServerNotif(notifSetting);
    setServerNotifApp(notifApp);
    setServerNotifResolved(resolveMode(notifSetting, notifSetting, notifSetting, notifApp));
    setServerPerm(permSetting);
    setServerPermApp(permApp);
    setServerPermResolved(resolvePermission(permSetting, permSetting, permSetting, permApp));
  }, []);

  const openServerSettings = async () => {
    if (!activeProfile) return;
    await refreshServerSettings(activeProfile);
    settingsRef.current?.present();
  };

  const selectServerNotif = async (mode: NotificationMode) => {
    if (!activeProfile) return;
    setServerNotif(mode);
    setServerNotifResolved(resolveMode(mode, mode, mode, serverNotifApp));
    await saveServerSetting(activeProfile.id, mode);
  };

  const selectServerPerm = async (mode: PermissionCascadeValue) => {
    if (!activeProfile) return;
    setServerPerm(mode);
    setServerPermResolved(resolvePermission(mode, mode, mode, serverPermApp));
    await saveServerPerm(activeProfile.id, mode);
  };

  // Reset downstream for this server: clears agent-level notification +
  // permission overrides for every agent on this server.
  const confirmReset = (title: string, message: string, run: () => Promise<void>) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive", onPress: () => void run() },
    ]);

  const resetServerNotifDownstream = async () => {
    if (!activeProfile) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const list = await listAgents({ profile: activeProfile, secret });
      const agentIds = list.map((a) => a.id);
      await resetServerDownstreamNotifications(agentIds);
      Alert.alert("Reset complete", `Cleared notification overrides for ${agentIds.length} agents on ${activeProfile.name}.`);
    } catch (e) {
      Alert.alert("Couldn't reset", e instanceof Error ? e.message : undefined);
    }
  };

  const resetServerPermDownstream = async () => {
    if (!activeProfile) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const list = await listAgents({ profile: activeProfile, secret });
      const agentIds = list.map((a) => a.id);
      await resetServerDownstreamPermissions(agentIds);
      Alert.alert("Reset complete", `Cleared permission overrides for ${agentIds.length} agents on ${activeProfile.name}.`);
    } catch (e) {
      Alert.alert("Couldn't reset", e instanceof Error ? e.message : undefined);
    }
  };

  // Downstream model application — pick a model, then apply it to every
  // conversation on this server. The settings sheet is dismissed before the
  // picker presents and re-presented when the picker closes (stacked-sheet
  // minimize/restore is unreliable, so this flow is fully explicit).
  const modelPickRef = useRef<BottomSheetModal>(null);
  const [chosenModelHandle, setChosenModelHandle] = useState<string | null>(null);
  const [applyingModel, setApplyingModel] = useState(false);
  const [pickFromSettings, setPickFromSettings] = useState(false);
  const chosenModelLabel = models.find((m) => m.handle === chosenModelHandle)?.label ?? null;

  const openModelPick = () => {
    if (!settingsRef.current) return;
    setPickFromSettings(true);
    settingsRef.current.dismiss();
    modelPickRef.current?.present();
  };

  useEffect(() => {
    if (!activeProfile) return;
    void (async () => {
      try {
        const secret = (await getSecret(activeProfile.id)) ?? "";
        setModels(await listModels({ profile: activeProfile, secret }));
      } catch {
        setModels([]);
      }
    })();
  }, [activeProfile]);

  const applyModelDownstream = async () => {
    if (!activeProfile || !chosenModelHandle) return;
    setApplyingModel(true);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const agentIds = (await listAgents({ profile: activeProfile, secret })).map((a) => a.id);
      const ids: string[] = [];
      for (const id of agentIds) {
        const convs = await listConversations({ profile: activeProfile, secret }, id, { limit: 100 });
        ids.push(...convs.map((c) => c.id));
      }
      const { updated, failed } = await applyModelToConversations({ profile: activeProfile, secret }, ids, chosenModelHandle);
      Alert.alert(
        failed > 0 ? "Applied with failures" : "Model applied",
        `${updated} conversation${updated === 1 ? "" : "s"} set to ${chosenModelLabel ?? chosenModelHandle}${failed > 0 ? `, ${failed} failed` : ""}.`,
      );
    } catch (e) {
      Alert.alert("Couldn't apply model", e instanceof Error ? e.message : undefined);
    } finally {
      setApplyingModel(false);
    }
  };

  const load = useCallback(async () => {
    const profile = activeProfile as Profile | null;
    if (!profile) return;
    setError(null);
    try {
      const secret = (await getSecret(profile.id)) ?? "";
      const list = await listAgents({ profile, secret });
      loadedAt.current = Date.now();
      setAgents(list);
      // In-progress indicators: one sweep covers every agent. Refreshed on a
      // cadence while the screen is shown — runs are transient, so a single
      // sample at entry misses most of them.
      const refreshActivity = () =>
        void fetchRunActivity({ profile, secret }).then((activity) =>
          setRunningAgents(activity.runningAgents),
        );
      refreshActivity();
      const activityTimer = setInterval(refreshActivity, 20_000);
      // Profile pictures load after the list renders — decoration, never a
      // blocker. Fetched once per agents-load, cached by MemFS commit.
      void (async () => {
        const entries = await Promise.all(
          list.map(async (agent) => [agent.id, await loadAgentAvatar({ profile, secret }, agent.id)] as const),
        );
        const next: Record<string, string> = {};
        for (const [id, url] of entries) {
          if (url) next[id] = url;
        }
        setAvatars(next);
      })();
      return () => clearInterval(activityTimer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load agents.");
      setAgents((prev) => prev ?? []);
    }
  }, [activeProfile]);

  useEffect(() => {
    // Defer past the synchronous effect body to satisfy the compiler's
    // cascading-render rule; load() sets state from network callbacks.
    const timer = setTimeout(() => {
      setAgents(null);
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Returning from a conversation, names and last-activity order are stale;
  // load() stamps loadedAt, so quick flips back don't refetch.
  const loadedAt = useRef(0);
  const refreshIfStale = useCallback(() => {
    if (Date.now() - loadedAt.current < 10_000) return;
    void load();
  }, [load]);
  useFocusEffect(refreshIfStale);

  const openCreate = async () => {
    if (!activeProfile) return;
    setEditing(null);
    setDraftName("");
    setDraftModel(null);
    sheetRef.current?.present();
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      setModels(await listModels({ profile: activeProfile, secret }));
    } catch {
      setModels([]);
    }
  };

  const openEdit = (agent: AgentSummary) => {
    setEditing(agent);
    setDraftName(agent.name);
    sheetRef.current?.present();
  };

  const submit = async () => {
    if (!activeProfile) return;
    setSaving(true);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const conn = { profile: activeProfile, secret };
      if (editing) {
        await updateAgent(conn, editing.id, { name: draftName.trim() });
      } else {
        if (!draftModel) return;
        await createAgent(conn, { name: draftName.trim() || "New agent", model: draftModel });
      }
      sheetRef.current?.dismiss();
      await load();
    } catch (e) {
      Alert.alert(editing ? "Couldn't rename agent" : "Couldn't create agent", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (agent: AgentSummary) => {
    Alert.alert(`Delete ${agent.name}?`, "This deletes the agent and its conversations.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (!activeProfile) return;
          const secret = (await getSecret(activeProfile.id)) ?? "";
          try {
            await deleteAgent({ profile: activeProfile, secret }, agent.id);
            haptic.queue();
            await load();
          } catch (e) {
            Alert.alert("Couldn't delete agent", e instanceof Error ? e.message : undefined);
          }
        },
      },
    ]);
  };

  const showActions = (agent: AgentSummary) => {
    Alert.alert(agent.name, undefined, [
      { text: "Rename", onPress: () => openEdit(agent) },
      { text: "Delete", style: "destructive", onPress: () => confirmDelete(agent) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const filtered = (agents ?? []).filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));
  const canSubmit = editing ? draftName.trim().length > 0 : draftModel !== null;

  return (
    <Screen>
      <Header
        title="Agents"
        large
        back
        subtitle={
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Connection: ${activeProfile?.name ?? "none"}. Switch connection`}
            onPress={() => router.dismissTo("/")}
            style={styles.profileChipTouch}
          >
            <View style={styles.profileChip}>
              <StatusDot tone={activeProfile ? "run" : "idle"} />
              <Text role="sub" ink={2}>
                {activeProfile?.name ?? "No connection"}
              </Text>
            </View>
          </Touchable>
        }
        trailing={
          <View style={styles.headerActions}>
            <Touchable accessibilityLabel="Settings" accessibilityRole="button" onPress={() => void openServerSettings()} style={styles.gear}>
              <Text role="title" ink={2}>
                ⚙
              </Text>
            </Touchable>
            <Touchable accessibilityLabel="Create agent" accessibilityRole="button" onPress={openCreate} style={styles.add}>
              <Text role="title" tone="accent">
                ＋
              </Text>
            </Touchable>
          </View>
        }
      />
      {agents !== null && agents.length > 0 ? (
        <View style={styles.searchWrap}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search agents…"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge, color: colors.ink }]}
          />
        </View>
      ) : null}

      {agents === null ? (
        <SkeletonList rows={5} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(a) => a.id}
          renderItem={({ item }) => (
            <AgentRow
              agent={item}
              avatarUrl={avatars[item.id]}
              running={runningAgents.has(item.id)}
              onPress={() => router.push({ pathname: "/conversations", params: { agentId: item.id, agentName: item.name } })}
              onLongPress={() => showActions(item)}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
              tintColor={colors.ink3}
            />
          }
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            error ? (
              <EmptyState message={error} actionLabel="Retry" onAction={() => void load()} />
            ) : search ? (
              <EmptyState message={`No agents match “${search}”.`} />
            ) : (
              <EmptyState message="No agents yet. Create your first one." actionLabel="Create agent" onAction={openCreate} />
            )
          }
        />
      )}

      <Sheet ref={sheetRef} title={editing ? "Rename agent" : "New agent"}>
        <TextInput
          value={draftName}
          onChangeText={setDraftName}
          placeholder="Agent name"
          placeholderTextColor={colors.ink3}
          style={[styles.sheetInput, { borderColor: colors.surfaceEdge, color: colors.ink }]}
        />
        {!editing ? (
          <View style={styles.modelBlock}>
            <Text role="micro" ink={3}>
              Model
            </Text>
            {models.length === 0 ? (
              <Text role="sub" ink={3}>
                Loading models…
              </Text>
            ) : (
              models.slice(0, 6).map((m) => (
                <Touchable
                  key={m.handle}
                  accessibilityRole="button"
                  accessibilityLabel={`Model ${m.label}${draftModel === m.handle ? ", selected" : ""}`}
                  onPress={() => setDraftModel(m.handle)}
                  style={styles.modelRow}
                >
                  <View style={styles.modelRowInner}>
                    <Text role="body">{m.label}</Text>
                    <Text role="sub" ink={3} mono style={styles.modelHandle}>
                      {m.handle}
                    </Text>
                    {draftModel === m.handle ? (
                      <Text role="bodyEm" tone="accent">
                        ✓
                      </Text>
                    ) : null}
                  </View>
                </Touchable>
              ))
            )}
          </View>
        ) : null}
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={editing ? "Save name" : "Create agent"}
          disabled={!canSubmit || saving}
          onPress={submit}
          style={[styles.sheetAction, { backgroundColor: colors.accent, opacity: canSubmit && !saving ? 1 : 0.5 }]}
        >
          <Text role="bodyEm" style={styles.sheetActionLabel}>
            {saving ? "Working…" : editing ? "Save" : "Create agent"}
          </Text>
        </Touchable>
      </Sheet>

      <Sheet ref={settingsRef} title="Server settings" scroll>
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
          onSelect={(mode) => void selectServerPerm(mode)}
        />
        <Text role="sub" ink={3} style={styles.permHint}>
          Default for agents on this server. Agents and conversations inherit this unless overridden.
        </Text>

        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Reset all agent permission overrides to server default"
          onPress={() =>
            confirmReset(
              "Reset agent permissions?",
              "Clears permission overrides for all agents on this server. They will inherit from the server and app defaults.",
              resetServerPermDownstream,
            )
          }
          style={styles.resetBtn}
        >
          <Text role="body" tone="danger">
            Reset all agent permission overrides
          </Text>
        </Touchable>

        <View style={styles.sectionDivider} />

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
          onSelect={(mode) => void selectServerNotif(mode)}
        />
        <Text role="sub" ink={3} style={styles.permHint}>
          Default for agents on this server. Agents and conversations inherit this unless overridden.
        </Text>

        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Reset all agent notification overrides to server default"
          onPress={() =>
            confirmReset(
              "Reset agent notifications?",
              "Clears notification overrides for all agents on this server. They will inherit from the server and app defaults.",
              resetServerNotifDownstream,
            )
          }
          style={styles.resetBtn}
        >
          <Text role="body" tone="danger">
            Reset all agent notification overrides
          </Text>
        </Touchable>

        <View style={styles.sectionDivider} />

        <Text role="micro" ink={3} style={styles.sectionLabel}>
          Model
        </Text>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={chosenModelLabel ? `Model: ${chosenModelLabel}` : "Choose a model"}
          onPress={openModelPick}
          style={styles.modelPickBtn}
        >
          <View style={styles.modelPickInner}>
            <View style={styles.modelPickText}>
              <Text role="body">{chosenModelLabel ?? "Choose a model…"}</Text>
              {chosenModelHandle ? (
                <Text role="sub" ink={3} mono numberOfLines={1}>
                  {chosenModelHandle}
                </Text>
              ) : (
                <Text role="sub" ink={3}>
                  Applies to every conversation on this server
                </Text>
              )}
            </View>
            <Text role="body" ink={3}>
              ▾
            </Text>
          </View>
        </Touchable>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Apply model to all conversations on this server"
          disabled={!chosenModelHandle || applyingModel}
          onPress={() =>
            confirmReset(
              "Apply model to all conversations?",
              `Sets every conversation on ${activeProfile?.name ?? "this server"} to ${chosenModelLabel}. Conversations already on this model are re-set harmlessly.`,
              applyModelDownstream,
            )
          }
          style={[styles.applyBtn, (!chosenModelHandle || applyingModel) && { opacity: 0.5 }]}
        >
          <Text role="body" tone="accent">
            {applyingModel ? "Applying…" : "Apply model to all conversations"}
          </Text>
        </Touchable>
      </Sheet>

      <ModelSheet
        ref={modelPickRef}
        models={models}
        currentModel={chosenModelHandle}
        currentEffort={null}
        onSelect={() => {}}
        onPick={(handle) => {
          setChosenModelHandle(handle);
          modelPickRef.current?.dismiss();
        }}
        onSheetDismiss={() => {
          if (pickFromSettings) {
            setPickFromSettings(false);
            settingsRef.current?.present();
          }
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: space.xxl, flexGrow: 1 },
  row: { paddingHorizontal: space.gutter },
  rowInner: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 14 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  rowText: { flex: 1, gap: 2 },
  meta: { flexDirection: "row", alignItems: "center", gap: space.xs },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  profileChip: { flexDirection: "row", alignItems: "center", gap: 6 },
  profileChipTouch: { minHeight: 24, alignSelf: "flex-start" },
  add: { paddingHorizontal: space.sm },
  headerActions: { flexDirection: "row", alignItems: "center" },
  gear: { paddingHorizontal: space.sm, marginRight: space.xs },
  permHint: { paddingTop: space.md, fontStyle: "italic" },
  resetBtn: { paddingVertical: space.sm, alignItems: "center" },
  modelPickBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 9,
  },
  modelPickInner: { flexDirection: "row", alignItems: "center", gap: space.sm },
  modelPickText: { flex: 1, gap: 1 },
  applyBtn: { paddingVertical: space.sm, alignItems: "center" },
  sectionLabel: { paddingTop: space.sm, paddingBottom: 2 },
  sectionDivider: { height: StyleSheet.hairlineWidth, marginVertical: space.md, backgroundColor: "transparent" },
  searchWrap: { paddingHorizontal: space.gutter, paddingBottom: space.sm },
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    fontSize: 15,
  },
  sheetInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  modelBlock: { gap: space.sm },
  modelRow: { minHeight: 40 },
  modelRowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 4 },
  modelHandle: { flex: 1 },
  sheetAction: { borderRadius: radius.row, alignItems: "center", marginTop: space.xs },
  sheetActionLabel: { color: "#FFFFFF", paddingVertical: 13 },
});
