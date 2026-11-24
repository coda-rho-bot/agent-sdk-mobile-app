# Client Strategy — Operators Console (Oct 2026)

Status: ACTIVE — approved direction, phased execution
Owner: Harry. Spec: Coda. Implementation: Angus. Product direction informed by Letta support-agent guidance (Ezra, Oct 10 2026, two rounds).

## 1. What we're building

Two clients, one product:

- **Desktop** — fork of letta-oss-ui (Electron). `~/dev/ai/letta-oss-ui`, Forgejo mirror pending.
- **Android** — Agents Chat, fork of agent-sdk-mobile-app (Expo/RN). `~/dev/ai/agents-chat`, Forgejo `coda/agents-chat`. 92 commits ahead of upstream, 0 behind; upstream dormant since Aug 15 → **operationally ours** (own security, Expo, SDK compat; cherry-pick if upstream revives).

**Product definition: an operator console for persistent assistants — not a chat app.**
Chat is the drill-down surface. The home screen answers: What needs me / Completed since last look / Problems / Next scheduled / Agents. Each item carries a provenance line: agent, conversation, trigger, runtime, timestamp.

This is NOT a new invention: it consolidates what's currently scattered across the Letta PWA, todos.angussoftware.dev, send_alert alerts, and cron run checks. The client becomes the single supervision surface.

## 2. Architecture rules (both clients)

1. **Cloud is canonical state. The SDK stream is NOT a cross-client event bus.**
2. Both apps pin the SAME @letta-ai/letta-agent-sdk version (currently: desktop 0.8.32, Android 0.7.1 → both move to 0.8.39).
3. Both import the `/client` subpath (portable impl) — no package-root imports in RN.
4. Shared internal package (monorepo or npm: `@angus/letta-client-core`): transcript projection + accumulator, otid/clientMessageId generation, error/result normalization, history pagination + foreground reconciliation, capability flags. ONE implementation, two shells.
5. Same Cloud principal; persisted agent/conversation IDs shared across clients.
6. **On every foreground/reconnect, in order:** resume conversation → bootstrapState()/listMessages() → rebase transcript accumulator → getDeviceStatus() (restores pending-approval UI) → reconcile optimistic sends by otid. No exceptions; the SDK does not replay missed events.
7. Durable (cross-client): memory, conversations, model settings, repo attachments. Session-local: client tools, approval callbacks, cwd, computer/sandbox selection, permission behavior. UI must show which is which — display the ACTUAL runtime/computer per turn, not just agent name.
8. Effective vs configured state: expose effective conversation model/runtime separately from agent defaults, with provenance for why a turn ran where it did (we've lived "configured device, silent sandbox fallback" — the UI must surface execution truth).

## 3. Notification rules (the reduce-noise contract)

1. **Notify once per logical outcome, not per lifecycle event.** A turn may emit assistant output, tool completion, result, run completion, failure record — that's ONE notification.
2. **First sync establishes a visibility baseline.** Never notify the historical backlog on fresh install.
3. Persist app-owned notification cursors + idempotency keys. Never infer "new" from absence.
4. Notification priority for scheduled agents: **approval required > material completion > schedule missed/failed > delivery failed.** Ordinary completion noise is the failure mode, not the goal.
5. **Collapse worker/subagent activity beneath the parent outcome.** Fleet UIs promote principals + human conversations; technical lifecycle is expand-on-demand, not first-class rows.
6. Per-conversation and per-device notification controls; app-owned read markers keyed (user, conversationId, lastReadMessageId) synchronized across devices — read state lives in OUR storage, never agent memory.

## 4. Phases

### Phase 1 — SDK migration (Android: 0.7.1 → 0.8.39; Desktop: 0.8.32 → 0.8.39)
Gates everything else. Treat as migration with contract tests, not a patch bump.
- Terminal handling: read through terminal `result`, use `result.errorCode`, never infer success/failure from socket closure; transport loss = recoverable `stream_closed` uncertainty; correlated `turn_finished` settles turns without trailing usage.
- TS strict: `SDKInitMessage.agentId` is now `string | null`.
- Peer dep: 0.8.38+ wants letta-code >=0.34.10 <0.35.0 (device bridge installs get bumped; version-check cron 735a9d72 already gates this).
- Lifecycle: idempotent `await client.close()`; one app-level client, sessions closed independently.
- Contract-test the terminal-behavior changes in the shared core (Phase 2 package lands as the extraction of this work).
- **Acceptance = Ezra's canary list, all green:** OAuth refresh; foreground/background mid-turn; approval recovery; queued sends; abort; images; long fragmented Markdown; conversation pagination; socket loss after send() before result.

### Phase 1.5 — Desktop parity backlog (post-Phase 2, build order)
Desktop gaps vs Android, sequenced so each lands as a thin pane over the shared core (no logic built twice):
1. OAuth login (kills manual key entry)
2. Send queue
3. Profiles (multi-account)
4. Attachments/images
5. Env/computer picker + execution truth (doubles as Phase 3 operator groundwork)
6. Angus theming tokens (independent of Phase 2 — can land anytime)

Reverse parity (desktop → Android, lower urgency): memory editor (read-only first), BYOK providers (likely desktop-only).
Not parity targets: background notifications (Phase 4 poller serves mobile), in-app updater, haptics/deep links.

### Phase 2 — Shared core package + parity
- Extract `@angus/letta-client-core` (rules §2.4) from the Android codebase's lib/ (it has the battle-tested parts: transcript projection, echo merge, oauth, updater tests already exist).
- Desktop consumes the same package. Parity target: identical reconciliation behavior on both.
- Lockfile hygiene: single lockfile (bun), delete the other.

### Phase 3 — Operator home screen (both clients)
Five sections, in order: **Needs you** (pending approvals, actionable failures, agent questions) / **Completed since you last looked** (material outcomes only) / **Problems** / **Next scheduled** (next occurrence + execution target + online status) / **Agents** (principals only).
- Approval cards: requesting agent + conversation, trigger (human/schedule/channel), tool + arguments, runtime + cwd, age/staleness, consequence of allow/deny. Approvals are server-authoritative — a second client renders "resolved elsewhere."
- Schedule rows distinguish Run-now from timed fire, and show execution truth vs configured target (the silent-fallback lesson, made structural).
- Chat remains one tap behind every item.

### Phase 4 — Background delivery backend (the poller's successor)
- Small service (our infra): central bounded polling of run/message state, dedupe by message/run ID, read-cursor store, FCM/Expo Push delivery.
- Mobile stops on-device FGS polling except as fallback; background sends move to `conversations.enqueue()` (server-owned delivery, replaces MOBILE_ONLY one-shot arming machinery).
- The 870-line Kotlin poller + 362-line backgroundPolling.ts shrink to a thin push receiver + fallback path.

## 5. Out of scope / explicitly deprioritized
- Elaborate orchestration UI; rendering every reasoning/tool lifecycle event by default; chat cosmetics; mirroring every backend object as a row; multi-user ACLs (single-operator product; revisit if that changes).

## 6. Records
- Ezra guidance (both rounds) archived in Coda memory: reference/projects/agents-chat.md § Ezra Guidance.
- Current-state review Oct 10: same file § Status. Hotspots: ChatSession.ts 1608 L, chat.tsx 1421 L — Phase 1/2 will be touching both; split as encountered, no big-bang refactor.
