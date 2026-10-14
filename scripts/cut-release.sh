#!/usr/bin/env bash
# Cut a GitHub release for the current snapshot. Tag scheme (full semver,
# mirroring the game version):
#   v<game version>     when the game version changed - released even if the
#                       map data itself did not change
#   v<version>.<n>      data-only updates after that version's initial
#                       release (the initial release is patch .0)
# Assets per release:
#   teyvat-full-<tag>.tar.gz            complete snapshot
#   teyvat-diff-<prev>-<tag>.tar.gz     changed/added files since the previous
#                                       release tag, plus DELETED.txt listing
#                                       removed files (tar cannot express
#                                       deletions)
# Environment: GH_TOKEN (repo), REAL_CHANGE ("true"/"false" from the commit
# step), NEW_SHA (commit to tag; defaults to HEAD when no fresh commit was
# made - the bootstrap case). Requires gh, jq, git with full history and
# tags. Reads snapshot-summary.json written by scripts/fetch-official.mjs.
set -euo pipefail

SUMMARY=snapshot-summary.json
[ -f "$SUMMARY" ] || { echo "no $SUMMARY - nothing to release"; exit 0; }

GAME=$(jq -r '.gameVersion // empty' "$SUMMARY")
PREV_GAME=$(jq -r '.prevGameVersion // empty' "$SUMMARY")
LATEST_TAG=$(git tag -l 'v*' | sort -V | tail -1)

tag_exists() { git rev-parse -q --verify "refs/tags/$1" >/dev/null; }

# Major base for this release: current game version if known, otherwise the
# latest existing tag with its patch component stripped. Patch .0 of the
# series is the major release itself.
if [ -n "$GAME" ]; then
  MAJOR="v${GAME%.*}"
elif [ -n "$LATEST_TAG" ]; then
  MAJOR=$(printf '%s' "$LATEST_TAG" | cut -d. -f1-2)
else
  MAJOR=""
fi

NEW_GAME_VERSION=false
[ -n "$GAME" ] && [ "$GAME" != "$PREV_GAME" ] && NEW_GAME_VERSION=true

TAG=""
if $NEW_GAME_VERSION && ! tag_exists "${MAJOR}.0"; then
  TAG="${MAJOR}.0" # new game version, release not cut yet
elif [ -z "$LATEST_TAG" ] && [ -n "$MAJOR" ]; then
  TAG="${MAJOR}.0" # bootstrap: no releases exist yet - cut the current version's
elif [ "${REAL_CHANGE:-false}" = "true" ] && [ -n "$MAJOR" ]; then
  LAST_PATCH=$(git tag -l "${MAJOR}.*" | sed "s/^${MAJOR}\.//" | sort -n | tail -1)
  TAG="${MAJOR}.$(( ${LAST_PATCH:-0} + 1 ))"
else
  echo "no new game version and no data changes - no release"
  exit 0
fi

if tag_exists "$TAG"; then
  echo "tag $TAG already exists - nothing to do"
  exit 0
fi

# --- Assets -----------------------------------------------------------------
FULL="teyvat-full-${TAG}.tar.gz"
tar -czf "$FULL" data/teyvat
ASSETS=("$FULL")

if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$TAG" ]; then
  STAGE=$(mktemp -d)
  git diff --name-only --diff-filter=ACMR "$LATEST_TAG" HEAD -- data/ |
    while IFS= read -r f; do
      mkdir -p "$STAGE/$(dirname "$f")"
      cp "$f" "$STAGE/$f"
    done
  DELETED=$(git diff --name-only --diff-filter=D "$LATEST_TAG" HEAD -- data/)
  if [ -n "$DELETED" ]; then
    printf '%s\n' $DELETED >"$STAGE/DELETED.txt"
  fi
  if [ -n "$(ls -A "$STAGE")" ]; then
    DIFF="teyvat-diff-${LATEST_TAG}-${TAG}.tar.gz"
    tar -czf "$DIFF" -C "$STAGE" .
    ASSETS+=("$DIFF")
  fi
fi

# --- Notes ------------------------------------------------------------------
NOTES=$(jq -r '
  "Game version: \(.gameVersion // "unknown")\n" +
  "Map version: \(.prevMapVersion // "n/a") -> \(.mapVersion)\n" +
  "Points: \(.prevPoints // "n/a") -> \(.points)\n" +
  "Tiles updated: \(.tilesWritten // 0) / \(.tilesQueued // 0) (unchanged: \(.tilesKept // 0))\n" +
  "Icons: \(.icons // 0)\n" +
  "Fetched at: \(.timestamp)"' "$SUMMARY")

# Resolve the target before calling gh: the REST API accepts a SHA or branch
# name for target_commitish, but NOT the literal "HEAD".
TARGET="${NEW_SHA:-$(git rev-parse HEAD)}"

gh release create "$TAG" \
  --title "Teyvat snapshot ${TAG#v}" \
  --target "$TARGET" \
  --notes "$NOTES" \
  "${ASSETS[@]}"
echo "created release $TAG with assets: ${ASSETS[*]}"
