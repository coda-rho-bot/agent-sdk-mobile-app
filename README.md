> [!NOTE]
> **You're looking at the `angus` branch — Agents Chat**, the Angus Software soft fork of Bloop with background notifications, per-conversation notification settings, cross-device sync, pinning, and more. Fork docs: [FORK.md](./FORK.md). Upstream PRs contributing pieces of this back: [#9](https://github.com/letta-ai/agent-sdk-mobile-app/pull/9) [#10](https://github.com/letta-ai/agent-sdk-mobile-app/pull/10) [#11](https://github.com/letta-ai/agent-sdk-mobile-app/pull/11) [#12](https://github.com/letta-ai/agent-sdk-mobile-app/pull/12).
> The `main` branch is a pristine mirror of upstream.

# Bloop — a mobile client for the Letta Agent SDK

Chat with your Letta agents from your phone: pick an agent, watch it think, run tools,
and ask you for permission before it does anything consequential. Works against
**Letta Cloud** or **your own machine** running a Letta app-server.

It is also a worked example. Every screen maps to a small number of files, and the
whole SDK story — resuming a session, reducing the stream into a transcript, approvals,
aborting, queued follow-ups — lives in one readable file you can lift into your own app.

| | | |
|---|---|---|
| ![Agent list](docs/press/agents-light.png) | ![Chat with tool calls and markdown](docs/press/chat-light.png) | ![Tool approval](docs/press/approval-dark.png) |

Built with Expo (React Native), TypeScript, and
[`@letta-ai/letta-agent-sdk`](https://github.com/letta-ai/letta-agent-sdk).

## Try it on your phone

Install [Expo Go](https://expo.dev/go) on your iPhone or Android device, then run:

```bash
git clone https://github.com/letta-ai/agent-sdk-mobile-app.git
cd agent-sdk-mobile-app
bun install
bunx expo start --tunnel
```

Scan the QR code shown in the terminal with your phone.

To build the native app locally instead:

```bash
bun run ios      # requires macOS and Xcode
bun run android  # requires Android Studio
```

Then connect it to one of two things.

**Letta Cloud** — choose *Letta Cloud* on the first screen, then continue in your browser
with OAuth or paste an API key from [platform.letta.com](https://platform.letta.com).
The reference build includes the general-purpose Letta Mobile public OAuth client and
uses `letta-mobile://oauth/callback`. Apps that need a separate OAuth identity can set
`EXPO_PUBLIC_LETTA_OAUTH_CLIENT_ID` and configure their own scheme. Access tokens,
refresh tokens, and API keys stay in the device keychain (`expo-secure-store`). Cloud
requests always use `https://api.letta.com`.

The distributed OAuth client is `ci-let-94bf2d5e34984a684fb6b18880b6bc7d`. It is a
public identifier, not a client secret. The registered redirect is
`letta-mobile://oauth/callback`, and the app always uses Authorization Code with PKCE.

**Your own machine** — run an app-server wherever your code lives:

```bash
npm install -g @letta-ai/letta-code
openssl rand -hex 24 > /tmp/ws-token
letta server --listen ws://0.0.0.0:4610 --ws-auth capability-token --ws-token-file /tmp/ws-token
```

Choose *Your own server*, enter `ws://<your-machine>:4610`, and paste that token. The
token is required from a phone: React Native always sends an `Origin` header, and
app-servers only accept those on token-authenticated upgrades.

> **This is a real terminal on that machine.** An agent connected to your own server can
> read files and run commands there. For anything beyond your own LAN, put it behind TLS
> (`wss://`) or a private network such as Tailscale, and treat the endpoint as a
> credential.

Requires **Agent SDK 0.7.x** with **letta-code ≥ 0.30.5**; the single-socket transport
means those two move together.

## What it does

- **Agents and conversations** — browse, search, create, rename, delete; cursor
  pagination on both lists and on message history.
- **Streaming chat** — assistant text as it arrives, collapsible reasoning with live
  think time, markdown with fenced code and tappable links, long-press to copy.
- **Tool calls** — status from running to settled with durations, a detail sheet with
  the full input and output, unified diffs coloured, and consecutive calls collapsed into
  one "Ran 5 tools" row so a long agentic turn stays readable.
- **Approvals** — when the agent wants to run something, you get the full command, the
  working directory, one-tap "always allow" suggestions, and allow/deny with a reason.
- **Permission modes** — strict, standard, accept-edits, unrestricted, switchable mid-conversation.
- **Interrupt and queue** — stop a running turn, or send follow-ups that queue behind it.
- **Attachments** — send screenshots and photos, downscaled on device.
- **Reconnect** — background the app and come back mid-turn; state reconciles against
  the server rather than guessing.

## How it's built

Two rules run through the whole app:

1. **The server is the truth.** Run phase, queue order, and approvals render only what
   the runtime confirms. Mutations show *pending*, never *pretend*.
2. **Opening a conversation is free.** History hydrates over REST; the SDK session — and
   on Cloud, its sandbox — is created lazily on the first send.

| Layer | Files | What it teaches |
| --- | --- | --- |
| SDK ↔ UI | `src/lib/letta/ChatSession.ts` | The whole story: `resumeSession`, reducing `stream()`, `canUseTool` approvals, abort, queue |
| Transcript rows | `src/lib/letta/transcriptProjection.ts` | Turning the SDK's `createTranscriptAccumulator()` rows into render state |
| Domain model | `src/lib/letta/model.ts` | The snapshot vocabulary the UI renders — the mock and real transports both speak it |
| Data layer | `src/lib/letta/api.ts` | Agents, conversations, models, history via the portable client |
| Mock transport | `src/lib/letta/mockSession.ts` | A fixture-driven fake session, so every UI state is reachable with no server |
| Design system | `src/theme/tokens.ts` | Colour, type, space, motion — everything visual resolves through tokens |

A note on idiom, since it is the point of the repo: row identity, delta accumulation and
replay suppression are **not** hand-rolled here. They belong to the SDK's transcript
accumulator, and this app keeps only what the SDK cannot know — which row is live, how
long a think took, and the two tool states the approval flow owns. Earlier versions of
this app did hand-roll them and got them subtly wrong; the shape you see is the second
answer, not the first.

Two dev-only routes are worth opening: **`/gallery`** renders every component in every
state against the mock transport (no server, no credentials), and **`/stills`** renders
the press screenshots.

Deeper detail lives in [`docs/design-doc.md`](docs/design-doc.md) (visual system,
screen map, and the screen→SDK operation map) and
[`docs/architecture.md`](docs/architecture.md).

## Making it yours

The name **Bloop** and its blue-sphere mark are placeholders, so the repo ships with
nobody's trademarks in it. To rebrand: edit `name`, `scheme`, and the bundle identifiers
in `app.json`, change the two colours in `src/theme/tokens.ts`, and run
`python3 scripts/make-icons.py` to regenerate the icon, adaptive icon, and splash mark.
Agent avatars derive their colour from the agent id using the same palette.

## License

Apache-2.0, assets included — there is no separate artwork carve-out, because the app
ships no third-party marks.

"Letta", "Letta Cloud" and "Letta Code" identify the service this client connects to.
That is nominative use and grants no rights in those marks; Apache-2.0 §6 grants none
either. Give a published fork its own name and icon.
