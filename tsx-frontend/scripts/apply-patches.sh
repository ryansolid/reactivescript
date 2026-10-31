#!/bin/sh
# Build the patched upstream tree the frontend runs on: a detached git worktree of a CLEAN reactivescript checkout at
# its current HEAD, with patches/NNNN-*.patch applied in order. The clean checkout is never modified.
#   sh scripts/apply-patches.sh CLEAN_CHECKOUT TARGET_DIR
# Exit 3 when a queued patch no longer applies (reported by the canary as patch-queue breakage).
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
CLEAN=$(cd "$1" && pwd); TARGET=$2
[ -z "$(git -C "$CLEAN" status --porcelain)" ] || { echo "clean checkout $CLEAN has local changes"; exit 2; }
COMMIT=$(git -C "$CLEAN" rev-parse HEAD)
[ -e "$TARGET" ] && { git -C "$CLEAN" worktree remove --force "$TARGET" 2>/dev/null || { echo "$TARGET exists and is not a worktree of $CLEAN"; exit 2; }; }
git -C "$CLEAN" worktree add -q --detach "$TARGET" "$COMMIT"
for p in "$HERE"/patches/[0-9][0-9][0-9][0-9]-*.patch; do
  [ -e "$p" ] || continue
  git -C "$TARGET" apply --check "$p" || { echo "PATCH QUEUE NO LONGER APPLIES: $(basename "$p") at $COMMIT"; exit 3; }
  git -C "$TARGET" apply "$p"; echo "applied $(basename "$p")"
done
echo "patched tree $TARGET at $COMMIT"
