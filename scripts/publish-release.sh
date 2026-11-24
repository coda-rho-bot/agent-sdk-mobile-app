#!/usr/bin/env bash
# Publish a release of the Agents Chat app.
#
# Single source of truth for the version: app.json ("expo.version").
# The gradle versionCode is (major*10000 + minor*100 + patch) so it
# increments automatically with the version string.
#
# Usage:
#   scripts/publish-release.sh            # bump patch, build, upload
#   scripts/publish-release.sh 0.4.0      # explicit version
#
# Requires: FORGEJO_CODA_TOKEN in env, ANDROID_HOME, JAVA_HOME.
#
# Release contract (consumed by the in-app updater):
#   Forgejo release tag:            v<version>
#   Asset: agents-chat-<version>.apk
#   Asset: latest.json              {"version": "...", "apk": "<asset UUID url>",
#                                    "versionCode": N, "releasedAt": "ISO8601"}
#   latest.json is attached to EVERY release, so the newest release's
#   latest.json is the current manifest (queried via ?limit=1 API).

set -euo pipefail

REPO_API="https://git.angussoftware.dev/api/v1/repos/coda/agents-chat-releases"
APK_DIR="android/app/build/outputs/apk/release"
SLUG="agents-chat"

die() { echo "ERROR: $*" >&2; exit 1; }

# --- resolve version -------------------------------------------------------
cd "$(dirname "$0")/.."

NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  python3 - <<'PY'
import json
d = json.load(open("app.json"))
v = d["expo"]["version"]
maj, min_, pat = (int(x) for x in v.split("."))
open("/tmp/ac-next-version","w").write(f"{maj}.{min_}.{pat+1}")
PY
  NEW_VERSION="$(cat /tmp/ac-next-version)"
  rm -f /tmp/ac-next-version
  echo "No version given — bumping patch → $NEW_VERSION"
fi

[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be semver: $NEW_VERSION"

VC_MAJOR=$(( ${NEW_VERSION%%.*} * 10000 ))
REST="${NEW_VERSION#*.}"
VC_MINOR=$(( ${REST%%.*} * 100 ))
VC_PATCH=$(( ${REST##*.} ))
VERSION_CODE=$(( VC_MAJOR + VC_MINOR + VC_PATCH ))
(( ${REST%%.*} < 100 && VC_PATCH < 100 )) || die "version scheme collides at minor/patch >= 100 (got $NEW_VERSION)"

# --- write version everywhere (single edit, both files) --------------------
python3 - "$NEW_VERSION" "$VERSION_CODE" <<'PY'
import json, re, sys
version, vcode = sys.argv[1], int(sys.argv[2])
d = json.load(open("app.json"))
d["expo"]["version"] = version
json.dump(d, open("app.json","w"), indent=2)
open("app.json","a").write("\n")

s = open("android/app/build.gradle").read()
s = re.sub(r"versionCode \d+", f"versionCode {vcode}", s)
s = re.sub(r'versionName "[^"]+"', f'versionName "{version}"', s)
open("android/app/build.gradle","w").write(s)
print(f"app.json + build.gradle → {version} (code {vcode})")
PY

if [[ -n "$(git status --porcelain app.json android/app/build.gradle)" ]]; then
  git add app.json
  git add -f android/app/build.gradle
  git -c user.name="coda-rho-bot" -c user.email="coda-github@mail.angussoftware.com" commit -m "chore: release v$NEW_VERSION"
fi

# --- build -----------------------------------------------------------------
echo "Building release APK…"
( cd android && ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}" \
    JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}" \
    ./gradlew app:assembleRelease -x lint -x lintVitalAnalyzeRelease -x lintVitalRelease -x test \
    -PreactNativeArchitectures=arm64-v8a ) > /tmp/ac-build.log 2>&1 \
  || { tail -20 /tmp/ac-build.log; die "build failed"; }

APK="$APK_DIR/app-release.apk"
[[ -f "$APK" ]] || die "APK missing at $APK"
SIZE=$(stat -c%s "$APK")

# --- upload ----------------------------------------------------------------
TAG="v$NEW_VERSION"
echo "Publishing $TAG (${SIZE} bytes)…"

RELEASE_ID=$(curl -s -X POST "$REPO_API/releases" \
  -H "Authorization: token $FORGEJO_CODA_TOKEN" -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"body\":\"Agents Chat $TAG\",\"prerelease\":false}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

upload_asset() {
  local name="$1" file="$2" type="$3"
  curl -s -X POST "$REPO_API/releases/$RELEASE_ID/assets?name=$name" \
    -H "Authorization: token $FORGEJO_CODA_TOKEN" \
    -F "attachment=@$file;type=$type" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('browser_download_url') or d)"
}

APK_URL=$(upload_asset "$SLUG-$NEW_VERSION.apk" "$APK" "application/vnd.android.package-archive")
[[ "$APK_URL" == https://* ]] || die "apk upload failed: $APK_URL"

RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"version":"%s","versionCode":%d,"apk":"%s","size":%d,"releasedAt":"%s"}\n' \
  "$NEW_VERSION" "$VERSION_CODE" "$APK_URL" "$SIZE" "$RELEASED_AT" > /tmp/ac-latest.json
MANIFEST_URL=$(upload_asset "latest.json" /tmp/ac-latest.json "application/json")
[[ "$MANIFEST_URL" == https://* ]] || die "manifest upload failed: $MANIFEST_URL"

rm -f /tmp/ac-latest.json /tmp/ac-build.log
echo
echo "PUBLISHED $TAG"
echo "  apk:      $APK_URL"
echo "  manifest: attached as latest.json to release $TAG (id $RELEASE_ID)"
echo
echo "NOTE: app.json commit exists locally — push it with the release PR or directly:"
echo "  git push origin angus   (release bump commits may go straight to angus)"
