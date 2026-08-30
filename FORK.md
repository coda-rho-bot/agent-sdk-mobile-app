# Fork notes — Agents Chat

Soft fork of [letta-ai/agent-sdk-mobile-app](https://github.com/letta-ai/agent-sdk-mobile-app) ("Bloop"), branded **Agents Chat** for Angus Software.

## Branch model

- `main` — pristine mirror of upstream `main`. **Never commit here.** Used only as the merge base for upstream changes.
- `angus` — Angus customizations. This is the working branch. Default for local dev.

## Remotes

- `origin` → `https://git.angussoftware.dev/coda/agents-chat.git` (Forgejo)
- `upstream` → `https://github.com/letta-ai/agent-sdk-mobile-app.git` (GitHub)

## Syncing with upstream

When upstream ships changes:

```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
git checkout angus
git rebase main
# resolve conflicts (should be rare — keep customizations file-isolated)
git push --force-with-lease origin angus
```

If the team prefers merge over rebase (preserves angus-branch history):

```bash
git checkout angus
git merge main
git push origin angus
```

Rebase keeps `angus` a clean patch series on top of upstream — prefer it unless history matters for a release.

## Customization rules

To keep upstream merges clean:

1. **Only touch files the README's "Making it yours" section names**: `app.json`, `src/theme/tokens.ts` (accent + brandMark), `scripts/make-icons.py` (BLOOP/FIELD constants), generated icons.
2. **Never rename upstream symbols** (e.g. the `Bloop` avatar component, `bloopColors`) — they are internal code, not branding. Renames = conflicts on every sync.
3. **New Angus features go in new files** where possible. If an upstream file must be edited, keep the diff minimal and prefer additive changes over rewrites.
4. **Regenerate icons after any brandMark change**: `python3 scripts/make-icons.py` (needs Pillow).

## Brand

| Token | Value | Source |
| --- | --- | --- |
| Accent (light) | `#004F50` | AngusColor.kt `primaryLight` |
| Accent (dark) | `#8CE3E2` | AngusColor.kt `primaryDark` |
| Brand sphere | `#004F50` on `#9CF1F0` | AngusColor.kt primary / primaryContainer |

Bundle ID / package: `com.angussoftware.agentschat`. URL schemes: `agents-chat` (app), `letta-mobile` (upstream OAuth callback — do not remove unless we register our own OAuth client).

## Build notes (Android)

**Gradle version:** Expo SDK 57 / RN 0.86 plugins are NOT Gradle 9 compatible. The `@react-native/gradle-plugin` included build uses `plugins { alias(libs.plugins...) }` which Gradle 9 removed from included build root scripts. `expo prebuild` may generate a Gradle 9.x wrapper — if so, downgrade it before building:

```bash
# After expo prebuild, before gradlew:
sed -i 's/gradle-9\.[0-9.]*-bin/gradle-8.14.3-bin/' android/gradle/wrapper/gradle-wrapper.properties
```

This is temporary — once Expo/RN plugins support Gradle 9, the default wrapper will work and this step can be removed.

**Build command:**
```bash
cd android && ANDROID_HOME=$HOME/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 \
  ./gradlew app:assembleDebug -x lint -x test --build-cache -PreactNativeArchitectures=arm64-v8a
```

**Install on device:**
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**Node deps:** `bun install` fails on node-pty (node-gyp missing). Use `npm install --legacy-peer-deps` instead.

## License

Apache-2.0 (upstream). "Agents Chat" is our name; "Letta" marks identify the service this client connects to (nominative use).
