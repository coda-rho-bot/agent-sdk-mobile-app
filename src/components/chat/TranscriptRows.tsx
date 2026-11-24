/**
 * Transcript rows — the chat's visual vocabulary (docs/design-doc.md §4.4).
 * Assistant prose is unboxed body text; everything else is progressively
 * disclosed and quieter than the prose.
 */
import { memo, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useTheme } from "../../theme/ThemeProvider";
import { motion, radius, space } from "../../theme/tokens";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { Markdown, useCopyFeedback } from "./Markdown";
import type { AssistantItem, ErrorItem, ReasoningItem, ToolItem, UserItem } from "../../lib/letta/model";
import type { ToolGroupItem } from "@angus/letta-client-core";

// ── User ────────────────────────────────────────────────────────────────────

// Row components are memoized: transcript items are immutable (upsertItem
// replaces only the changed item), so during a streaming flush every settled
// row skips its render on reference equality alone.
export const UserBubble = memo(function UserBubble({ item, onRetry }: { item: UserItem; onRetry?: () => void }) {
  const { colors } = useTheme();
  const { copied, copy } = useCopyFeedback(item.text);
  return (
    <View style={styles.userRow}>
      <Touchable
        accessibilityRole={item.failed ? "button" : "none"}
        accessibilityLabel={item.failed ? "Message not sent. Retry" : item.text}
        accessibilityHint="Long press to copy"
        onPress={item.failed ? onRetry : undefined}
        onLongPress={copy}
        scaleOnPress={item.failed}
        style={styles.userTouch}
      >
        <View
          style={[
            styles.userBubble,
            { backgroundColor: colors.bubble, opacity: item.pending ? 0.6 : 1 },
          ]}
        >
          {item.images?.length ? (
            <View style={styles.userImages}>
              {/* Indexed: the same image can legitimately be attached twice. */}
              {item.images.map((uri, index) => (
                <Image key={`${index}-${uri}`} source={{ uri }} style={styles.userImage} contentFit="cover" />
              ))}
            </View>
          ) : null}
          {item.text ? <Text style={styles.userText}>{item.text}</Text> : null}
        </View>
        {item.failed ? (
          <Text role="sub" tone="danger" style={styles.userMeta}>
            Not sent · Tap to retry
          </Text>
        ) : null}
        {copied ? (
          <Text role="sub" ink={3} style={styles.userMeta}>
            Copied
          </Text>
        ) : null}
      </Touchable>
    </View>
  );
});

/**
 * Breathing "Thinking…" row shown at the transcript's live edge between a
 * send being accepted and the first streamed token — the turn never looks
 * dead while the model spins up.
 */
export function ThinkingRow() {
  return (
    <View style={styles.thinkingRow}>
      <Breathe />
      <Text role="sub" ink={3}>
        Thinking…
      </Text>
    </View>
  );
}

// ── Assistant ───────────────────────────────────────────────────────────────

/** Pulsing block caret appended while streaming. */
function Caret() {
  const { colors } = useTheme();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(withRepeat(
      withTiming(0.15, { duration: motion.caret.duration, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    ));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View style={[styles.caret, { backgroundColor: colors.ink2 }, style]} />
  );
}

export const AssistantBlock = memo(function AssistantBlock({ item }: { item: AssistantItem }) {
  const { copied, copy } = useCopyFeedback(item.text);
  return (
    <Touchable
      accessibilityRole="none"
      accessibilityHint="Long press to copy"
      // Copy only once the text is final — mid-stream it would be a torn read.
      onLongPress={item.streaming ? undefined : copy}
      scaleOnPress={false}
      style={styles.assistant}
    >
      <Markdown text={item.text} />
      {item.streaming ? <Caret /> : null}
      {item.interrupted ? (
        <Text role="sub" ink={3} style={styles.interrupted}>
          Stopped
        </Text>
      ) : null}
      {copied ? (
        <Text role="sub" ink={3}>
          Copied
        </Text>
      ) : null}
    </Touchable>
  );
});

// ── Reasoning ───────────────────────────────────────────────────────────────

/** Breathing dot shown while the agent is thinking. */
function Breathe() {
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.set(withRepeat(
      withTiming(motion.breathe.scaleTo + 0.14, {
        duration: motion.breathe.duration / 2,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    ));
  }, [scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <Animated.View style={[styles.breathe, { backgroundColor: colors.ink3 }, style]} />
  );
}

/**
 * Live elapsed think time ticks on the wall clock — long silent stretches
 * between deltas are exactly when the counter must keep moving.
 */
function useThinkSeconds(item: ReasoningItem): number {
  const [now, setNow] = useState(() => Date.now());
  const live = Boolean(item.streaming && item.startedAt);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (!item.streaming || !item.startedAt) return item.seconds;
  // `now` can predate this think (state persists across items); clamp so a
  // stale clock reads 1s until the first tick corrects it.
  return Math.max(1, Math.round((Math.max(now, item.startedAt) - item.startedAt) / 1000));
}

/** Last non-empty line, clipped from the left — the newest thought wins. */
function tailLine(text: string): string | null {
  const lines = text.trim().split("\n");
  const line = lines[lines.length - 1]?.trim();
  if (!line) return null;
  return line.length > 72 ? `…${line.slice(-72)}` : line;
}

export const ReasoningRow = memo(function ReasoningRow({ item }: { item: ReasoningItem }) {
  const [expanded, setExpanded] = useState(false);
  const seconds = useThinkSeconds(item);
  // History rows have no duration — show a plain label instead of "0s".
  const label = item.streaming
    ? `Thinking · ${seconds}s`
    : item.seconds > 0
      ? `Thought for ${item.seconds}s`
      : "Thought";
  const preview = item.streaming && !expanded ? tailLine(item.text) : null;
  return (
    <View>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${expanded ? "Collapse" : "Expand"} reasoning`}
        onPress={() => setExpanded((v) => !v)}
        style={styles.reasoning}
      >
        <View style={styles.reasoningInner}>
          {item.streaming ? <Breathe /> : null}
          <Text role="sub" ink={2}>
            {label}
          </Text>
          {preview ? (
            <Text role="sub" ink={3} numberOfLines={1} style={styles.reasoningPreview}>
              {preview}
            </Text>
          ) : null}
          <Text role="sub" ink={3}>
            {expanded ? "▾" : "›"}
          </Text>
        </View>
      </Touchable>
      {expanded && item.text ? (
        <Text role="sub" ink={2} style={styles.reasoningDetail}>
          {item.text}
        </Text>
      ) : null}
    </View>
  );
});

// ── Tool card ───────────────────────────────────────────────────────────────

/** Soft shimmer strip across a pending/running tool card. */
function Shimmer() {
  const { colors } = useTheme();
  const x = useSharedValue(-1);
  useEffect(() => {
    x.set(withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, false));
  }, [x]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() * 160 }],
  }));
  return (
    <View pointerEvents="none" style={styles.shimmerClip}>
      <Animated.View style={[styles.shimmer, { backgroundColor: colors.pressed }, style]} />
    </View>
  );
}

const toolGlyph: Record<ToolItem["status"], string> = {
  pending: "◌",
  running: "◌",
  awaiting_approval: "◔",
  success: "✓",
  denied: "⃠",
  error: "✗",
};

/**
 * Collapsed run of tool calls: one quiet summary line with the failure count,
 * tapped to re-inline the individual cards.
 */
export const ToolGroupRow = memo(function ToolGroupRow({
  group,
  onToggle,
}: {
  group: ToolGroupItem;
  onToggle: () => void;
}) {
  const names = [...new Set(group.tools.map((t) => t.name))];
  const label = `Ran ${group.tools.length} tool${group.tools.length === 1 ? "" : "s"}`;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${label}${group.failed > 0 ? `, ${group.failed} failed` : ""}. ${
        group.expanded ? "Collapse" : "Expand"
      }`}
      onPress={onToggle}
      style={styles.reasoning}
    >
      <View style={styles.reasoningInner}>
        <Text role="sub" ink={2}>
          {label}
        </Text>
        {group.failed > 0 ? (
          <Text role="sub" tone="danger">
            {group.failed} failed
          </Text>
        ) : null}
        <Text role="sub" ink={3} numberOfLines={1} style={styles.reasoningPreview} mono>
          {names.slice(0, 3).join(", ")}
          {names.length > 3 ? "…" : ""}
        </Text>
        <Text role="sub" ink={3}>
          {group.expanded ? "▾" : "›"}
        </Text>
      </View>
    </Touchable>
  );
});

export const ToolCard = memo(function ToolCard({ item, onPress }: { item: ToolItem; onPress?: () => void }) {
  const { colors } = useTheme();
  const { copied, copy } = useCopyFeedback(item.input ?? item.summary);
  const active = item.status === "pending" || item.status === "running";
  const glyphTone =
    item.status === "error" || item.status === "denied"
      ? "danger"
      : item.status === "awaiting_approval"
        ? "wait"
        : undefined;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`Tool ${item.name}, ${item.status.replace("_", " ")}. Details`}
      accessibilityHint="Long press to copy input"
      onPress={onPress}
      onLongPress={copy}
      scaleOnPress={false}
      style={[styles.toolCard, { borderColor: colors.surfaceEdge, backgroundColor: colors.surface }]}
    >
      {active ? <Shimmer /> : null}
      <View style={styles.toolHead}>
        <Text role="sub" ink={2} tone={glyphTone}>
          {toolGlyph[item.status]}
        </Text>
        <Text role="sub" ink={2} mono>
          {item.name}
        </Text>
        {item.durationMs !== undefined ? (
          <Text role="sub" ink={3}>
            · {(item.durationMs / 1000).toFixed(1)}s
          </Text>
        ) : null}
        {item.status === "awaiting_approval" ? (
          <Text role="sub" tone="wait">
            · needs approval
          </Text>
        ) : null}
        {item.status === "denied" ? (
          <Text role="sub" tone="danger">
            · denied
          </Text>
        ) : null}
      </View>
      <Text role="sub" ink={2} mono numberOfLines={1}>
        {item.summary}
      </Text>
      {copied ? (
        <Text role="sub" ink={3}>
          Copied
        </Text>
      ) : null}
    </Touchable>
  );
});

// ── Error ───────────────────────────────────────────────────────────────────

export const ErrorRow = memo(function ErrorRow({ item, onRetry }: { item: ErrorItem; onRetry?: () => void }) {
  return (
    <View style={styles.errorRow}>
      <Text role="sub" tone="danger">
        {item.message}
      </Text>
      {item.retryable ? (
        <Touchable accessibilityRole="button" accessibilityLabel="Retry" onPress={onRetry} style={styles.retry}>
          <Text role="sub" tone="accent">
            Retry
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  userRow: { alignItems: "flex-end", gap: 4 },
  userImages: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginBottom: 6 },
  userImage: { width: 96, height: 96, borderRadius: 10 },
  userTouch: { borderRadius: radius.bubble },
  thinkingRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 24 },
  userBubble: {
    maxWidth: "82%",
    borderRadius: radius.bubble,
    borderBottomRightRadius: radius.bubbleTail,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  userText: { fontSize: 15, lineHeight: 21 },
  userMeta: { paddingRight: space.xs },
  assistant: { gap: 4 },
  caret: { width: 7, height: 15, borderRadius: 1.5, marginLeft: 2, transform: [{ translateY: 2 }] },
  interrupted: { marginTop: 2 },
  reasoning: { minHeight: 28 },
  reasoningInner: { flexDirection: "row", alignItems: "center", gap: space.sm },
  reasoningPreview: { flex: 1 },
  reasoningDetail: { paddingLeft: space.lg, paddingBottom: space.xs },
  breathe: { width: 8, height: 8, borderRadius: 4 },
  toolCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 4,
    overflow: "hidden",
  },
  toolHead: { flexDirection: "row", alignItems: "center", gap: space.xs },
  shimmerClip: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, overflow: "hidden" },
  shimmer: { position: "absolute", top: 0, bottom: 0, width: 90, transform: [{ skewX: "-18deg" }] },
  errorRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  retry: { minHeight: 32 },
});
