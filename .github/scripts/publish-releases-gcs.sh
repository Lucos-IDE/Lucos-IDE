#!/usr/bin/env bash
# Upload Lucos release artifacts to a public GCS bucket (Path A).
#
# Required env:
#   DIST_DIR          Directory with merged CI artifacts
#   GCS_BUCKET        e.g. lucos-releases-staging
#   GCS_CHANNEL       insider | stable
#   RELEASE_VERSION   e.g. 0.1.8 or 142-abc1234
#
# Optional env:
#   GCS_PUBLIC_BASE   default: https://storage.googleapis.com/${GCS_BUCKET}
#   GIT_REF           commit SHA for manifest metadata
set -euo pipefail

DIST_DIR="${DIST_DIR:?DIST_DIR is required}"
GCS_BUCKET="${GCS_BUCKET:?GCS_BUCKET is required}"
GCS_CHANNEL="${GCS_CHANNEL:?GCS_CHANNEL is required}"
RELEASE_VERSION="${RELEASE_VERSION:?RELEASE_VERSION is required}"
GCS_PUBLIC_BASE="${GCS_PUBLIC_BASE:-https://storage.googleapis.com/${GCS_BUCKET}}"
GIT_REF="${GIT_REF:-}"
QUALITY="${QUALITY:-}"

if [[ "$GCS_CHANNEL" != "insider" && "$GCS_CHANNEL" != "stable" ]]; then
  echo "GCS_CHANNEL must be insider or stable" >&2
  exit 1
fi

find_artifact() {
  local pattern="$1"
  local file
  file=$(find "$DIST_DIR" -maxdepth 1 -type f -name "$pattern" 2>/dev/null | head -1)
  if [[ -z "$file" ]]; then
    return 1
  fi
  printf '%s' "$file"
}

declare -A PLATFORM_PATTERNS=(
  ["macos-arm64"]="Lucos-darwin-arm64*.dmg"
  ["macos-x64"]="Lucos-darwin-x64*.dmg"
  ["windows"]="LucosSetup*.exe"
  ["linux"]="*.deb"
  ["linux-appimage"]="Lucos-*-linux-x64.AppImage"
)

declare -A PLATFORM_FILES=(
  ["macos-arm64"]="macos-arm64.dmg"
  ["macos-x64"]="macos-x64.dmg"
  ["windows"]="windows.exe"
  ["linux"]="linux.deb"
  ["linux-appimage"]="linux.appimage"
)

MANIFEST_DIR=$(mktemp -d)
MANIFEST_PATH="$MANIFEST_DIR/${GCS_CHANNEL}.json"
PUBLISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "Publishing channel=$GCS_CHANNEL version=$RELEASE_VERSION to gs://$GCS_BUCKET"

platforms_json=""
uploaded=0

for platform in macos-arm64 macos-x64 windows linux linux-appimage; do
  src=$(find_artifact "${PLATFORM_PATTERNS[$platform]}") || continue
  canonical="${PLATFORM_FILES[$platform]}"
  versioned_object="${GCS_CHANNEL}/v${RELEASE_VERSION}/${canonical}"
  latest_object="latest/${GCS_CHANNEL}/${canonical}"

  echo "  -> $platform: $(basename "$src") as $canonical"

  gsutil -q cp "$src" "gs://${GCS_BUCKET}/${versioned_object}"
  gsutil -q cp "$src" "gs://${GCS_BUCKET}/${latest_object}"

  sha256=$(sha256sum "$src" | awk '{print $1}')
  size=$(stat -c%s "$src" 2>/dev/null || stat -f%z "$src")
  versioned_url="${GCS_PUBLIC_BASE}/${versioned_object}"
  latest_url="${GCS_PUBLIC_BASE}/${latest_object}"

  if [[ -n "$platforms_json" ]]; then
    platforms_json+=","
  fi
  platforms_json+=$(cat <<EOF
"$platform": {
  "fileName": "$canonical",
  "url": "$latest_url",
  "versionedUrl": "$versioned_url",
  "sha256": "$sha256",
  "size": $size
}
EOF
)
  uploaded=$((uploaded + 1))
done

if [[ "$uploaded" -eq 0 ]]; then
  echo "No artifacts found in $DIST_DIR" >&2
  ls -la "$DIST_DIR" >&2 || true
  exit 1
fi

cat >"$MANIFEST_PATH" <<EOF
{
  "version": "$RELEASE_VERSION",
  "quality": "${QUALITY:-$GCS_CHANNEL}",
  "channel": "$GCS_CHANNEL",
  "publishedAt": "$PUBLISHED_AT",
  "ref": "$GIT_REF",
  "platforms": {
    $platforms_json
  }
}
EOF

# -h is a gsutil global option (must come before the subcommand).
gsutil -q \
  -h "Content-Type:application/json" \
  -h "Cache-Control:public, max-age=60" \
  cp "$MANIFEST_PATH" "gs://${GCS_BUCKET}/releases/${GCS_CHANNEL}.json"

echo ""
echo "Published $uploaded artifact(s)."
echo "Manifest: ${GCS_PUBLIC_BASE}/releases/${GCS_CHANNEL}.json"
