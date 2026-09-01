/**
 * Conversations for one agent — live list with create, rename, and cursor
 * pagination (docs/design-doc.md §4.3). Cloud lists via REST, remote via
 * protocol `conversation_list`.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadPinned, pinnedConversationsKey, togglePinned } from "../lib/favorites";

import { Dropdown } from "../components/ui/Dropdown";
import { EmptyState } from "../components/ui/EmptyState";
import { Header, Screen } from "../components/ui/Screen";
import { Sheet } from "../components/ui/Sheet";
import { SkeletonList } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { ModelSheet } from "../components/chat/ModelSheet";
import {
  applyModelToConversations,
  canDeleteConversations,
  createConversation,
  deleteConversation,
    fetchRunActivity,
  fetchLastAssistantPreview,
listConversations,
  listModels,
  renameConversation,
  type ConversationSummary,
  type ModelOption,
} from "../lib/letta/api";
import {
  conversationActivity,
  subscribeConversationActivity,
  type ConversationActivity,
} from "../lib/letta/ChatSession";
import { getSecret, type Profile } from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import {
  NotificationMode,
  labelWithResolution,
  resolveMode,
  loadAppDefault,
  loadAgentSetting,
  saveAgentSetting,
  loadServerSetting,
  resetAgentDownstreamNotifications,
} from "../lib/notifications";
import {
  PermissionCascadeMode,
  type PermissionCascadeValue,
  permLabelWithResolution,
  permissionDetail,
  loadAppPermDefault,
  loadAgentPerm,
  saveAgentPerm,
  loadServerPerm,
  resolvePermission,
  resetAgentDownstreamPermissions,
} from "../lib/permissions";
import { useTheme } from "../theme/ThemeProvider";
import { radius, space } from "../theme/tokens";

const PAGE_SIZE = 30;

function relativeTime(iso?: string): string {
  if (!iso) return "no messages yet";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Live state for conversations open on this device; null when idle. */
function useActivity(conversationId: string): ConversationActivity | null {
  const read = useCallback(() => conversationActivity(conversationId), [conversationId]);
  return useSyncExternalStore(subscribeConversationActivity, read);
}

function ConversationRow({ conversation, preview, running, pinned, onPress, onLongPress }: {
  conversation: ConversationSummary;
  preview?: string | null;
  running?: boolean;
  pinned?: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  const activity = useActivity(conversation.id);
  const activityLabel =
    activity === "awaiting_approval" ? "needs approval" : activity === "running" ? "running" : null;
  const inProgress = running || activity === "running";
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${conversation.title}. ${
        activityLabel ? `${activityLabel}. ` : ""
      }${relativeTime(conversation.lastMessageAt)}`}
      onPress={onPress}
      onLongPress={onLongPress}
      scaleOnPress={false}
      style={styles.row}
    >
      <View style={styles.rowInner}>
        <View style={styles.rowText}>
          <Text role="bodyEm" numberOfLines={1}>
            {pinned ? "★ " : ""}
            {conversation.title}
          </Text>
          {inProgress ? (
            <View style={styles.runningRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text role="sub" ink={2} numberOfLines={1}>
                {activityLabel ?? "working…"}
              </Text>
            </View>
          ) : (
            <Text role="sub" ink={2} numberOfLines={2}>
              {preview ?? relativeTime(conversation.lastMessageAt)}
            </Text>
          )}
        </View>
        {activity ? (
          <StatusDot tone={activity === "awaiting_approval" ? "wait" : "run"} />
        ) : null}
      </View>
      <View style={[styles.divider, { backgroundColor: colors.surfaceEdge }]} />
    </Touchable>
  );
}

export default function ConversationsScreen() {
  const params = useLocalSearchParams<{ agentId: string; agentName?: string }>();
  const agentId = params.agentId;
  const agentName = params.agentName ?? "Agent";
  const { colors } = useTheme();
  const { activeProfile } = useProfiles();

  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const actionsSheetRef = useRef<BottomSheetModal>(null);
  const [actionTarget, setActionTarget] = useState<ConversationSummary | null>(null);
  const [runningConvs, setRunningConvs] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState("");
  const renameSheetRef = useRef<BottomSheetModal>(null);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  // Agent settings sheet state — agent-level notification + permission defaults,
  // plus reset for all conversation overrides downstream.
  const agentSettingsRef = useRef<BottomSheetModal>(null);
  const [agentNotifSetting, setAgentNotifSetting] = useState<NotificationMode>(NotificationMode.SERVER_DEFAULT);
  const [agentNotifResolved, setAgentNotifResolved] = useState<NotificationMode>(NotificationMode.OFF);
  const [agentNotifServer, setAgentNotifServer] = useState<NotificationMode>(NotificationMode.APP_DEFAULT);
  const [agentNotifApp, setAgentNotifApp] = useState<NotificationMode>(NotificationMode.OFF);
  const [agentPermSetting, setAgentPermSetting] = useState<PermissionCascadeValue>(PermissionCascadeMode.SERVER_DEFAULT);
  const [agentPermResolved, setAgentPermResolved] = useState<PermissionCascadeValue>(PermissionCascadeMode.STANDARD);
  const [agentPermServer, setAgentPermServer] = useState<PermissionCascadeValue>(PermissionCascadeMode.APP_DEFAULT);
  const [agentPermApp, setAgentPermApp] = useState<PermissionCascadeValue>(PermissionCascadeMode.STANDARD);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      const [notifSetting, notifServer, notifApp, permSetting, permServer, permApp] = await Promise.all([
        loadAgentSetting(agentId),
        activeProfile ? loadServerSetting(activeProfile.id) : Promise.resolve(NotificationMode.APP_DEFAULT),
        loadAppDefault(),
        loadAgentPerm(agentId),
        activeProfile ? loadServerPerm(activeProfile.id) : Promise.resolve(PermissionCascadeMode.APP_DEFAULT),
        loadAppPermDefault(),
      ]);
      if (cancelled) return;
      setAgentNotifSetting(notifSetting);
      setAgentNotifServer(notifServer);
      setAgentNotifApp(notifApp);
      setAgentNotifResolved(resolveMode(notifSetting, notifServer, notifApp, notifApp));
      setAgentPermSetting(permSetting);
      setAgentPermServer(permServer);
      setAgentPermApp(permApp);
      setAgentPermResolved(resolvePermission(permSetting, permServer, permApp, permApp));
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, activeProfile]);

  const openAgentSettings = () => {
    agentSettingsRef.current?.present();
  };

  const selectAgentNotif = async (mode: NotificationMode) => {
    setAgentNotifSetting(mode);
    setAgentNotifResolved(resolveMode(mode, agentNotifServer, agentNotifApp, agentNotifApp));
    await saveAgentSetting(agentId, mode);
  };

  const selectAgentPerm = async (mode: PermissionCascadeValue) => {
    setAgentPermSetting(mode);
    setAgentPermResolved(resolvePermission(mode, agentPermServer, agentPermApp, agentPermApp));
    await saveAgentPerm(agentId, mode);
  };

  // Reset downstream for this agent: clears conversation-level overrides for
  // every conversation under this agent.
  const confirmReset = (title: string, message: string, run: () => Promise<void>) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive", onPress: () => void run() },
    ]);

  const resetConvNotifDownstream = async () => {
    if (!activeProfile) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const convs = await listConversations({ profile: activeProfile, secret }, agentId, { limit: 100 });
      const convIds = convs.map((c) => c.id);
      await resetAgentDownstreamNotifications(convIds);
      Alert.alert("Reset complete", `Cleared notification overrides for ${convIds.length} conversations on ${agentName}.`);
    } catch (e) {
      Alert.alert("Couldn't reset", e instanceof Error ? e.message : undefined);
    }
  };

  const resetConvPermDownstream = async () => {
    if (!activeProfile) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const convs = await listConversations({ profile: activeProfile, secret }, agentId, { limit: 100 });
      const convIds = convs.map((c) => c.id);
      await resetAgentDownstreamPermissions(convIds);
      Alert.alert("Reset complete", `Cleared permission overrides for ${convIds.length} conversations on ${agentName}.`);
    } catch (e) {
      Alert.alert("Couldn't reset", e instanceof Error ? e.message : undefined);
    }
  };

  // Downstream model application — pick a model, then apply it to every
  // conversation on this agent. The settings sheet is dismissed before the
  // picker presents and re-presented when the picker closes (stacked-sheet
  // minimize/restore is unreliable, so this flow is fully explicit).
  const modelPickRef = useRef<BottomSheetModal>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [chosenModelHandle, setChosenModelHandle] = useState<string | null>(null);
  const [applyingModel, setApplyingModel] = useState(false);
  const [pickFromSettings, setPickFromSettings] = useState(false);
  const chosenModelLabel = models.find((m) => m.handle === chosenModelHandle)?.label ?? null;

  const openModelPick = () => {
    if (!agentSettingsRef.current) return;
    setPickFromSettings(true);
    agentSettingsRef.current.dismiss();
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
      const convs = await listConversations({ profile: activeProfile, secret }, agentId, { limit: 100 });
      const ids = convs.map((c) => c.id);
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
    if (!profile || !agentId) return;
    setError(null);
    try {
      const secret = (await getSecret(profile.id)) ?? "";
      const page = await listConversations({ profile, secret }, agentId, { limit: PAGE_SIZE });
      loadedAt.current = Date.now();
      setConversations(page);
      setHasMore(page.length === PAGE_SIZE);
      // Decoration layers — never block the list on these.
      // In-progress: one sweep covers every conversation. Refreshed on a
      // cadence while the screen is shown (runs are transient).
      const refreshActivity = () =>
        void fetchRunActivity({ profile, secret }).then((activity) =>
          setRunningConvs(activity.runningConversations),
        );
      refreshActivity();
      const activityTimer = setInterval(refreshActivity, 20_000);
      // Last-reply previews: cached by conversation id + last activity, so
      // only conversations with new messages re-fetch.
      void (async () => {
        const results = await Promise.all(
          page.slice(0, 20).map(async (conv) => {
            const cacheKey = `letta.preview.${conv.id}`;
            try {
              const cached = await AsyncStorage.getItem(cacheKey);
              if (cached) {
                const parsed = JSON.parse(cached) as { at?: string; text?: string };
                if (parsed.text && parsed.at === conv.lastMessageAt) return [conv.id, parsed.text] as const;
              }
            } catch {
              // cache miss — fetch fresh
            }
            const text = await fetchLastAssistantPreview({ profile, secret }, conv.id);
            if (text) {
              try {
                await AsyncStorage.setItem(cacheKey, JSON.stringify({ at: conv.lastMessageAt, text }));
              } catch {
                // ignore
              }
            }
            return [conv.id, text] as const;
          }),
        );
        const map: Record<string, string> = {};
        for (const [id, text] of results) {
          if (text) map[id] = text;
        }
        setPreviews(map);
      })();
      return () => clearInterval(activityTimer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load conversations.");
      setConversations((prev) => prev ?? []);
    }
  }, [activeProfile, agentId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!agentId) return;
    void loadPinned(pinnedConversationsKey(agentId)).then(setPinned);
  }, [agentId]);

  // Coming back from a chat, the list is stale: titles get auto-summarized and
  // a new conversation may exist. Refetch on focus, but not on every quick
  // flip back and forth.
  // load() stamps this; 0 means "never loaded", so the first focus refetches.
  const loadedAt = useRef(0);
  const refreshIfStale = useCallback(() => {
    if (Date.now() - loadedAt.current < 10_000) return;
    void load();
  }, [load]);
  useFocusEffect(refreshIfStale);

  const loadMore = async () => {
    if (!activeProfile || !conversations?.length || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const page = await listConversations({ profile: activeProfile, secret }, agentId, {
        limit: PAGE_SIZE,
        before: conversations[conversations.length - 1]!.id,
      });
      setConversations([...conversations, ...page]);
      setHasMore(page.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const openChat = (conversation: ConversationSummary) => {
    router.push({
      pathname: "/chat",
      params: { conversationId: conversation.id, agentId, agentName, title: conversation.title },
    });
  };

  const startNew = async () => {
    if (!activeProfile) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const id = await createConversation({ profile: activeProfile, secret }, agentId);
      router.push({ pathname: "/chat", params: { conversationId: id, agentId, agentName, title: "New conversation" } });
    } catch (e) {
      Alert.alert("Couldn't start a conversation", e instanceof Error ? e.message : undefined);
    }
  };

  // Alert.prompt is iOS-only, so renaming rides the app's own sheet + input.
  const openRename = (conversation: ConversationSummary) => {
    setRenaming(conversation);
    setDraftTitle(conversation.title);
    renameSheetRef.current?.present();
  };

  const submitRename = async () => {
    const title = draftTitle.trim();
    if (!activeProfile || !renaming || !title) return;
    renameSheetRef.current?.dismiss();
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      await renameConversation({ profile: activeProfile, secret }, renaming.id, title);
      await load();
    } catch (e) {
      Alert.alert("Couldn't rename", e instanceof Error ? e.message : undefined);
    }
  };

  const confirmDelete = (conversation: ConversationSummary) => {
    Alert.alert(`Delete “${conversation.title}”?`, "The conversation and its history are removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (!activeProfile) return;
          const secret = (await getSecret(activeProfile.id)) ?? "";
          // Optimistic: the row leaves immediately, restored if the call fails.
          const previous = conversations;
          setConversations((rows) => (rows ?? []).filter((c) => c.id !== conversation.id));
          try {
            await deleteConversation({ profile: activeProfile, secret }, conversation.id);
          } catch (e) {
            setConversations(previous);
            Alert.alert("Couldn't delete", e instanceof Error ? e.message : undefined);
          }
        },
      },
    ]);
  };

  const showActions = (conversation: ConversationSummary) => {
    setActionTarget(conversation);
    actionsSheetRef.current?.present();
  };

  const filtered = (conversations ?? [])
    .filter((c) => c.title.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));

  return (
    <Screen>
      <Header
        title={agentName}
        large
        back
        subtitle={
          <Text role="sub" ink={2}>
            {conversations ? `${conversations.length}${hasMore ? "+" : ""} conversations` : "Conversations"}
          </Text>
        }
        trailing={
          <View style={styles.headerActions}>
            <Touchable
              accessibilityLabel="Agent settings"
              accessibilityRole="button"
              onPress={openAgentSettings}
              style={styles.gear}
            >
              <Text role="title" ink={2}>
                ⚙
              </Text>
            </Touchable>
            <Touchable accessibilityLabel="New conversation" accessibilityRole="button" onPress={startNew} style={styles.add}>
              <Text role="title" tone="accent">
                ＋
              </Text>
            </Touchable>
          </View>
        }
      />
      {conversations !== null && conversations.length > 0 ? (
        <View style={styles.searchWrap}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search conversations…"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge, color: colors.ink }]}
          />
        </View>
      ) : null}
      {conversations === null ? (
        <SkeletonList rows={6} avatar={false} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <ConversationRow
              conversation={item}
              preview={previews[item.id]}
              running={runningConvs.has(item.id)}
              pinned={pinned.has(item.id)}
              onPress={() => openChat(item)}
              onLongPress={() => showActions(item)}
            />
          )}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
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
          ListFooterComponent={
            loadingMore ? (
              <Text role="sub" ink={3} style={styles.footer}>
                Loading more…
              </Text>
            ) : (
              <Text role="sub" ink={3} style={styles.footer}>
                Long-press a conversation for actions.
              </Text>
            )
          }
          ListEmptyComponent={
            error ? (
              <EmptyState message={error} actionLabel="Retry" onAction={() => void load()} />
            ) : search.trim() ? (
              <EmptyState message={`No conversations match “${search.trim()}”.`} />
            ) : (
              <EmptyState message="No conversations yet." actionLabel="New conversation" onAction={startNew} />
            )
          }
        />
      )}
      <Sheet ref={renameSheetRef} title="Rename conversation">
        <TextInput
          value={draftTitle}
          onChangeText={setDraftTitle}
          placeholder="Conversation title"
          placeholderTextColor={colors.ink3}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void submitRename()}
          style={[styles.sheetInput, { borderColor: colors.surfaceEdge, color: colors.ink }]}
        />
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Save title"
          onPress={() => void submitRename()}
          disabled={draftTitle.trim().length === 0}
          style={[
            styles.sheetAction,
            { backgroundColor: colors.accent, opacity: draftTitle.trim().length === 0 ? 0.4 : 1 },
          ]}
        >
          <Text role="bodyEm" style={styles.sheetActionLabel}>
            Save
          </Text>
        </Touchable>
      </Sheet>

      <Sheet ref={agentSettingsRef} title={agentName} scroll>
        <Dropdown
          label="Notification default"
          value={agentNotifSetting}
          options={
            (
              [
                NotificationMode.OFF,
                NotificationMode.MOBILE_ONLY,
                NotificationMode.ALL_MESSAGES,
                NotificationMode.SERVER_DEFAULT,
                NotificationMode.APP_DEFAULT,
              ] as NotificationMode[]
            ).map((option) => ({
              value: option,
              label: labelWithResolution(option, agentNotifResolved),
              danger: option === NotificationMode.OFF,
            }))
          }
          onSelect={(mode) => void selectAgentNotif(mode)}
        />
        <Text role="sub" ink={3} style={styles.permHint}>
          Default for this agent's conversations. Individual conversations can override this in the chat.
        </Text>

        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Reset all conversation notification overrides to agent default"
          onPress={() =>
            confirmReset(
              "Reset conversation notifications?",
              "Clears notification overrides for all conversations on this agent. They will inherit from the agent and server defaults.",
              resetConvNotifDownstream,
            )
          }
          style={styles.resetBtn}
        >
          <Text role="body" tone="danger">
            Reset all conversation notification overrides
          </Text>
        </Touchable>

        <View style={styles.sectionDivider} />

        <Dropdown
          label="Permission default"
          value={agentPermSetting}
          options={
            (
              [
                PermissionCascadeMode.STRICT,
                PermissionCascadeMode.STANDARD,
                PermissionCascadeMode.ACCEPT_EDITS,
                PermissionCascadeMode.UNRESTRICTED,
                PermissionCascadeMode.SERVER_DEFAULT,
                PermissionCascadeMode.APP_DEFAULT,
              ] as PermissionCascadeValue[]
            ).map((option) => ({
              value: option,
              label: permLabelWithResolution(option, agentPermResolved),
              detail: permissionDetail(option),
              danger: option === PermissionCascadeMode.UNRESTRICTED,
            }))
          }
          onSelect={(mode) => void selectAgentPerm(mode)}
        />
        <Text role="sub" ink={3} style={styles.permHint}>
          Default for this agent's conversations. Individual conversations can override this in the chat.
        </Text>

        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Reset all conversation permission overrides to agent default"
          onPress={() =>
            confirmReset(
              "Reset conversation permissions?",
              "Clears permission overrides for all conversations on this agent. They will inherit from the agent and server defaults.",
              resetConvPermDownstream,
            )
          }
          style={styles.resetBtn}
        >
          <Text role="body" tone="danger">
            Reset all conversation permission overrides
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
                  Applies to every conversation on this agent
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
          accessibilityLabel="Apply model to all conversations on this agent"
          disabled={!chosenModelHandle || applyingModel}
          onPress={() =>
            confirmReset(
              "Apply model to all conversations?",
              `Sets every conversation on ${agentName} to ${chosenModelLabel}. Conversations already on this model are re-set harmlessly.`,
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
            agentSettingsRef.current?.present();
          }
        }}
      />
      <Sheet
        ref={actionsSheetRef}
        title={actionTarget?.title ?? "Actions"}
        onSheetDismiss={() => setActionTarget(null)}
      >
        {actionTarget ? (
          (() => {
            const pinKey = agentId ? pinnedConversationsKey(agentId) : null;
            const pinnedNow = pinned.has(actionTarget.id);
            const deletable = activeProfile
              ? canDeleteConversations({ profile: activeProfile, secret: "" })
              : false;
            return (
              <>
                {pinKey ? (
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={pinnedNow ? `Unpin ${actionTarget.title}` : `Pin ${actionTarget.title} to top`}
                    onPress={() => {
                      void togglePinned(pinKey, actionTarget.id).then(setPinned);
                      actionsSheetRef.current?.dismiss();
                    }}
                    style={styles.actionRow}
                  >
                    <Text role="body">{pinnedNow ? "★ Unpin" : "☆ Pin to top"}</Text>
                  </Touchable>
                ) : null}
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${actionTarget.title}`}
                  onPress={() => {
                    actionsSheetRef.current?.dismiss();
                    openRename(actionTarget);
                  }}
                  style={styles.actionRow}
                >
                  <Text role="body">Rename</Text>
                </Touchable>
                {deletable ? (
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${actionTarget.title}`}
                    onPress={() => {
                      actionsSheetRef.current?.dismiss();
                      confirmDelete(actionTarget);
                    }}
                    style={styles.actionRow}
                  >
                    <Text role="body" tone="danger">
                      Delete
                    </Text>
                  </Touchable>
                ) : null}
              </>
            );
          })()
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: { paddingVertical: 14 },
  runningRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  list: { paddingBottom: space.xxl, flexGrow: 1 },
  row: { paddingHorizontal: space.gutter },
  rowInner: { flexDirection: "row", alignItems: "center", paddingVertical: 14 },
  rowText: { flex: 1, gap: 2 },
  divider: { height: StyleSheet.hairlineWidth },
  add: { paddingHorizontal: space.sm },
  gear: { paddingHorizontal: space.sm, marginRight: space.xs },
  headerActions: { flexDirection: "row", alignItems: "center" },
  sectionLabel: { paddingTop: space.sm, paddingBottom: 2 },
  sectionDivider: { height: StyleSheet.hairlineWidth, marginVertical: space.md, backgroundColor: "transparent" },
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
  footer: { textAlign: "center", paddingVertical: space.md },
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
    paddingVertical: 11,
    fontSize: 16,
  },
  sheetAction: { minHeight: 46, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  sheetActionLabel: { color: "#FFFFFF" },
});
