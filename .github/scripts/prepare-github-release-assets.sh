#!/usr/bin/env bash
# Rename release artifacts to the canonical Lucos naming contract and emit latest.json.
#
# Usage:
#   prepare-github-release-assets.sh <version> <commit> <dist_dir>
#
# Output files are written into <dist_dir>.
set -euo pipefail

VERSION="${1:?version is required}"
COMMIT="${2:?commit is required}"
DIST_DIR="${3:?dist_dir is required}"

find_artifact() {
	local pattern="$1"
	find "$DIST_DIR" -maxdepth 1 -type f -name "$pattern" 2>/dev/null | head -1
}

rename_if_found() {
	local pattern="$1"
	local target_name="$2"
	local src
	src=$(find_artifact "$pattern") || return 1
	local dest="$DIST_DIR/$target_name"
	if [[ "$(basename "$src")" != "$target_name" ]]; then
		mv "$src" "$dest"
	else
		dest="$src"
	fi
	printf '%s' "$dest"
}

declare -A ASSET_SPECS=(
	["darwin-arm64"]="lucos-arm64.dmg:lucos-${VERSION}-darwin-arm64.dmg"
	["darwin-x64"]="lucos-x64.dmg:lucos-${VERSION}-darwin-x64.dmg"
	["win32-x64"]="lucos.exe:lucos-${VERSION}-win32-x64.exe"
	["linux-x64"]="lucos.deb:lucos-${VERSION}-linux-x64.deb"
	["linux-x64-appimage"]="lucos.AppImage:lucos-${VERSION}-linux-x64.AppImage"
)

ASSETS_JSON=""
PUBLISHED=0
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for key in darwin-arm64 darwin-x64 win32-x64 linux-x64 linux-x64-appimage; do
	IFS=':' read -r pattern target <<< "${ASSET_SPECS[$key]}"
	if file=$(rename_if_found "$pattern" "$target"); then
		sha256=$(sha256sum "$file" | awk '{print $1}')
		if [[ -n "$ASSETS_JSON" ]]; then
			ASSETS_JSON+=","
		fi
		ASSETS_JSON+=$(cat <<EOF
"$key": {
  "name": "$target",
  "sha256": "$sha256"
}
EOF
)
		PUBLISHED=$((PUBLISHED + 1))
	fi
done

if [[ "$PUBLISHED" -eq 0 ]]; then
	echo "No release artifacts found in $DIST_DIR" >&2
	ls -la "$DIST_DIR" >&2 || true
	exit 1
fi

cat >"$DIST_DIR/latest.json" <<EOF
{
  "version": "$VERSION",
  "commit": "$COMMIT",
  "timestamp": "$TIMESTAMP",
  "assets": {
    $ASSETS_JSON
  }
}
EOF

echo "Prepared $PUBLISHED artifact(s) and latest.json in $DIST_DIR"
ls -lh "$DIST_DIR"
