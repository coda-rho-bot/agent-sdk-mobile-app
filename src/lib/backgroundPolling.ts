/**
 * Background polling — root-level lifecycle for external run-completion
 * notifications while the app is backgrounded.
 *
 * Owned by the root layout's AppState listener (NOT the chat screen): the
 * user may background the app from any screen, and "All messages" is a
 * per-conversation setting that should notify regardless of which
 * conversation (if any) was open. On background: enumerate all
 * conversations whose effective mode is ALL_MESSAGES and hand them to the
 * native Kotlin poller (modules/background-poll). On foreground: stop.
 *
 * The poller is native because JS timers never fire in backgrounded RN
 * contexts (main context pauses timers on host pause; headless contexts
 * don't drive them on the bridgeless runtime) — see Lesson #716.
 */
import { startPolling as nativeStartPolling, armOneShot as nativeArmOneShot, disarmOneShot as nativeDisarmOneShot, isOneShotArmed as nativeIsOneShotArmed, type NativeConversationSpec } from "../../modules/background-poll";
import { listAgents, listConversations } from "./letta/api";
import { NotificationMode, resolveEffectiveMode, loadAvatarShape } from "./notifications";
import type { Profile } from "./profiles/profiles";
import { getSecret } from "./profiles/profiles";

const MAX_CONVERSATIONS = 50;
const MAX_AGENTS = 10;

let startInFlight = false;
/**
 * Serializes every nativeStartPolling call (enumeration starts AND arm
 * fell-through cold starts). onStartCommand rebuilds the watched map from
 * the intent's spec list, so two concurrent starts interleave as
 * replace-not-merge: the loser's specs vanish. The chain serializes them;
 * arm cold starts re-check pollerRunning inside their link and arm live
 * when a predecessor already started the service.
 */
let coldStartChain: Promise<void> = Promise.resolve();
/**
 * Resolvers waiting for the in-flight enumeration-driven start to drain.
 * Send-time arms that hit the startInFlight defer branch wait on these,
 * then re-check liveness and arm live (or cold if the enumeration failed).
 */
let startDrainWaiters: (() => void)[] = [];
/**
 * Conversation ids handed to the native poller this session. The JS-side
 * notification path (chat.tsx handleRunCompletion) consults this to avoid
 * DOUBLE notifications: the poller posts the rich notification for watched
 * conversations (always-on since foreground polling landed), so the JS path
 * must defer to it. Unset when the poller stops.
 */
const nativelyWatched = new Set<string>();

/**
 * Live chat sessions, registered by the chat screen. MOBILE_ONLY
 * notifications fire only for runs started from this app — and when the
 * app backgrounds, JS pauses, so the native poller must take over delivery.
 * It can't see client identity, so this registry tells enumeration which
 * conversations have a locally-started run still in flight.
 */
interface LocalRunWatch {
  agentId: string;
  title: string;
  agentName?: string;
  hasLocalRun: () => boolean;
}
const localRuns = new Map<string, LocalRunWatch>();

/** Register/unregister a live chat session for MOBILE_ONLY background delivery. */
export function registerLocalRunWatch(
  conversationId: string,
  watch: LocalRunWatch | null,
): void {
  if (watch) localRuns.set(conversationId, watch);
  else localRuns.delete(conversationId);
}

/**
 * Enumerate ALL_MESSAGES conversations for the profile and start the native
 * poller. No-op (with log) if none qualify or the profile/token is missing.
 */

/** True when the native poller is watching this conversation (its notifications own it). */
export function isNativelyWatched(conversationId: string): boolean {
  return nativelyWatched.has(conversationId);
}
export async function startBackgroundPollingForProfile(profile: Profile | null): Promise<void> {
  if (startInFlight) return;
  startInFlight = true;
  try {
    if (!profile) {
      console.log("[BG-POLL] no active profile — not starting");
      return;
    }
    const secret = (await getSecret(profile.id)) ?? "";
    if (!secret) {
      console.log(`[BG-POLL] no secret for profile ${profile.id} — not starting`);
      return;
    }
    const conn = { profile, secret };
    const pollStartedAt = Date.now();
    const avatarShape = await loadAvatarShape();

    // Enumerate agents → conversations, keep those resolving to ALL_MESSAGES.
    const specs: NativeConversationSpec[] = [];
    try {
      const agents = await listAgents(conn);
      for (const agent of agents.slice(0, MAX_AGENTS)) {
        const conversations = await listConversations(conn, agent.id, { limit: 20 });
        for (const conv of conversations) {
          const mode = await resolveEffectiveMode(conv.id, agent.id, profile.id);
          if (mode !== NotificationMode.ALL_MESSAGES) continue;
          specs.push({
            conversationId: conv.id,
            agentId: agent.id,
            title: conv.title ?? "Conversation",
            agentName: agent.name ?? "Agent",
          });
          if (specs.length >= MAX_CONVERSATIONS) break;
        }
        if (specs.length >= MAX_CONVERSATIONS) break;
      }
    } catch (e) {
      console.log(`[BG-POLL] enumeration failed (${e instanceof Error ? e.message : String(e)}) — not starting`);
      return;
    }

    // MOBILE_ONLY: register live conversations whose current run was started
    // from this app — the native poller takes over delivery while JS is
    // paused (one-shot specs: they retire after the turn's completion).
    for (const [convId, watch] of localRuns) {
      if (!watch.hasLocalRun()) continue;
      if (specs.some((s) => s.conversationId === convId)) continue; // ALL_MESSAGES already covers it
      specs.push({
        conversationId: convId,
        agentId: watch.agentId,
        title: watch.title,
        agentName: watch.agentName,
        onlyLocalRun: true,
      });
      console.log(`[BG-POLL] MOBILE_ONLY one-shot registered conv=${convId.slice(-8)}`);
    }

    // Send-time-armed one-shots (chat screen armed at send, then unmounted —
    // the leave-screen gap): carry them across the re-enumeration so the
    // watched-map rebuild doesn't drop them. STALENESS GUARD: only carry a
    // spec the native poller still holds armed — retirement (turn already
    // completed) removes it from the native watched map, and re-pushing a
    // retired spec would make a MOBILE_ONLY conversation notify on any
    // EXTERNAL run (the poller can't distinguish client identity). Belt:
    // a mounted session whose local run already ended is skipped too.
    for (const [convId, spec] of armedOneShots) {
      if (specs.some((s) => s.conversationId === convId)) continue; // ALL_MESSAGES or localRuns already covers it
      const liveWatch = localRuns.get(convId);
      if (liveWatch && !liveWatch.hasLocalRun()) {
        // Session still mounted, local run finished — the JS onTurnCompleted
        // retire raced the enumeration. Drop the record, don't re-push.
        armedOneShots.delete(convId);
        continue;
      }
      const stillArmedNatively = await nativeIsOneShotArmed(convId);
      if (!stillArmedNatively) {
        armedOneShots.delete(convId);
        continue;
      }
      specs.push(spec);
      console.log(`[BG-POLL] carry-over one-shot conv=${convId.slice(-8)}`);
    }

    nativelyWatched.clear();
    if (specs.length === 0) {
      console.log("[BG-POLL] no ALL_MESSAGES conversations and no local MOBILE_ONLY runs — not starting");
      return;
    }
    for (const spec of specs) nativelyWatched.add(spec.conversationId);
    console.log(`[BG-POLL] starting for ${specs.length} conversation(s): ${specs.map((s) => s.conversationId.slice(-8)).join(",")}`);
    // Join the cold-start chain: an enumeration start must serialize against
    // arm fell-through cold starts (same interleave class — one side's
    // nativeStartPolling replacing the other's watched map mid-flight).
    const runEnumerationStart = async (): Promise<void> => {
      await nativeStartPolling({
        conversations: specs,
        baseUrl:
          profile.type === "remote" && profile.url
            ? // Remote profiles store a ws(s):// URL — REST needs http(s)://.
              profile.url.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:")
            : "https://api.letta.com",
        token: secret,
        pollStartedAt,
        notifiedRunIds: [],
        avatarShape,
      });
      pollerRunning = true;
    };
    coldStartChain = coldStartChain.then(runEnumerationStart, runEnumerationStart);
    await coldStartChain;
  } finally {
    startInFlight = false;
    // Wake any send-time arms that deferred to this enumeration — they
    // re-check poller liveness and arm live (or cold if this start failed
    // and they still need to deliver their spec).
    const waiters = startDrainWaiters;
    startDrainWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * True once startPolling has succeeded this app session (poller is live).
 * Monotonic by design: the poller runs for the app's whole lifetime
 * (foregrounded too — per-conversation suppression is handled by
 * setVisibleConversation), so nothing stops it and the flag never resets.
 */
let pollerRunning = false;

/**
 * Send-time-armed one-shot specs, keyed by conversation. Tracked so a
 * re-enumeration (AppState change) rebuilds the watched map WITHOUT losing
 * specs armed for sessions that already unmounted. RETIREMENT IS
 * DETERMINISTIC: entries are removed on send failure (disarm), on local
 * turn completion (chat.tsx retire), and on carry-over when the spec is
 * found stale (native retirement or finished mounted run). Entries are
 * NEVER blindly re-pushed: the poller cannot distinguish client identity,
 * so a re-pushed dead spec would notify on external runs — the
 * MOBILE_ONLY violation.
 */
const armedOneShots = new Map<string, NativeConversationSpec>();

/**
 * Send-time arm of the one-shot MOBILE_ONLY watch. Called the moment a
 * local run starts — BEFORE the user can leave the screen — so delivery
 * no longer depends on the chat session staying mounted (the leave-screen
 * gap: session unmount tears down the JS callback, and no AppState change
 * fires to trigger enumeration while the app stays foreground).
 *
 * If the poller is live, arms incrementally (no re-enumeration, no API
 * calls). If not running yet (cold start: no ALL_MESSAGES conversations
 * anywhere), falls back to a full start with just this spec — the poller
 * service then runs until retired.
 *
 * Only call this for MOBILE_ONLY conversations: arming an ALL_MESSAGES
 * conversation would overwrite its regular (non-one-shot) watch with a
 * one-shot that retires after a single turn.
 */
export async function armMobileOnlyOneShot(
  conversationId: string,
  meta: { agentId: string; title: string; agentName?: string },
  conn: { profile: Profile; secret: string } | null,
): Promise<void> {
  const spec: NativeConversationSpec = {
    conversationId,
    agentId: meta.agentId,
    title: meta.title,
    agentName: meta.agentName,
    onlyLocalRun: true,
  };
  armedOneShots.set(conversationId, spec);
  if (pollerRunning) {
    const armed = await nativeArmOneShot(spec);
    if (armed) {
      nativelyWatched.add(conversationId);
      console.log(`[BG-POLL] one-shot armed at send (live) conv=${conversationId.slice(-8)}`);
      return;
    }
    // Service died underneath us (stopped/crashed) — cold-start with this spec.
    console.log(`[BG-POLL] arm fell through to cold start conv=${conversationId.slice(-8)}`);
  }
  // Cold start: poller not running. The caller passes the connection it
  // already resolved for the send (profile + secret) — no context lookup.
  if (!conn || !conn.secret) {
    console.log("[BG-POLL] one-shot arm aborted — no connection");
    return;
  }
  if (startInFlight) {
    // An enumeration-driven start is mid-flight. Do NOT simply return: the
    // enumeration may fail (leaving the poller cold), and this spec must be
    // delivered regardless. Wait for the drain, then re-check liveness and
    // arm live — or fall through to the cold start if it never came up.
    console.log(`[BG-POLL] one-shot arm waiting for in-flight enumeration conv=${conversationId.slice(-8)}`);
    await new Promise<void>((resolve) => {
      startDrainWaiters.push(resolve);
    });
    // Retired-while-parked discriminator (same signal the enumeration's
    // staleness belt uses): if the session that armed this is still mounted
    // and its local run has ENDED, the turn already completed — onTurnCompleted
    // retired the record, and re-asserting would resurrect a dead spec. A
    // post-drain cold start captures pollStartedAt NOW, so the ended turn is
    // invisible to sweeps: the spec would linger and notify on the next
    // EXTERNAL run (MOBILE_ONLY violation). Unmounted sessions have no
    // localRuns entry — their arms proceed (the leave-screen case).
    const liveWatch = localRuns.get(conversationId);
    if (liveWatch && !liveWatch.hasLocalRun()) return; // retired during park
    // Re-assert the record: the enumeration's carry-over consulted
    // isOneShotArmed against a service that wasn't running yet and may
    // have deleted it as "stale". Without this, the next AppState
    // re-enumeration rebuilds without this spec — onStartCommand's
    // watched.clear() drops the live one-shot (leave-screen gap, one
    // AppState later).
    armedOneShots.set(conversationId, spec);
    if (pollerRunning) {
      const armed = await nativeArmOneShot(spec);
      if (armed) {
        nativelyWatched.add(conversationId);
        console.log(`[BG-POLL] one-shot armed post-drain (live) conv=${conversationId.slice(-8)}`);
        return;
      }
    }
    // Enumeration drained without a live poller — fall through to cold
    // start (armedOneShots holds this spec for future carry-overs).
    console.log(`[BG-POLL] one-shot arm fell through post-drain to cold start conv=${conversationId.slice(-8)}`);
  }
  const avatarShape = await loadAvatarShape();
  // Serialize fell-through cold starts: two deferred arms draining without
  // a live poller must not interleave (A's nativeStartPolling([specA])
  // suspended before pollerRunning=true → B starts [specB] → the service
  // rebuild replaces A's watch). The chain serializes them; the liveness
  // re-check inside makes the loser arm live instead of re-starting.
  const runColdStart = async (): Promise<void> => {
    if (pollerRunning) {
      const armed = await nativeArmOneShot(spec);
      if (armed) {
        nativelyWatched.add(conversationId);
        console.log(`[BG-POLL] one-shot armed via cold-start chain (live re-check) conv=${conversationId.slice(-8)}`);
        return;
      }
    }
    await nativeStartPolling({
      conversations: [spec],
      baseUrl:
        conn.profile.type === "remote" && conn.profile.url
          ? conn.profile.url.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:")
          : "https://api.letta.com",
      token: conn.secret,
      pollStartedAt: Date.now(),
      notifiedRunIds: [],
      avatarShape,
    });
    // Set only after the native start resolves — a throw leaves the flag
    // honest (a retry arm will re-attempt the cold start).
    pollerRunning = true;
    nativelyWatched.add(conversationId);
    console.log(`[BG-POLL] one-shot armed at send (cold start) conv=${conversationId.slice(-8)}`);
  };
  coldStartChain = coldStartChain.then(runColdStart, runColdStart);
  await coldStartChain;
}

/** Disarm a send-time one-shot (send failed — nothing to wait for). */
export async function disarmMobileOnlyOneShot(conversationId: string): Promise<void> {
  armedOneShots.delete(conversationId);
  nativelyWatched.delete(conversationId);
  await nativeDisarmOneShot(conversationId);
}

/**
 * Retire the armed-record after the local turn completed on the JS side
 * (session still mounted — onTurnCompleted fired). Native-side retirement
 * already happened (the poller fired or consumed the turn); this drops the
 * JS record so a later re-enumeration doesn't carry a dead spec forward.
 * nativelyWatched is NOT touched: for the window between completion and
 * retirement the double-notification guard must keep suppressing the JS
 * path, and enumeration rebuilds it anyway.
 */
export function retireMobileOnlyOneShotRecord(conversationId: string): void {
  armedOneShots.delete(conversationId);
}
