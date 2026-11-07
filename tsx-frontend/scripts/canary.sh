#!/bin/sh
# Build and check an upstream revision in a disposable sibling layout; never change the pinned workspace.
set -eu
REV=${1:?usage: canary.sh REV [--dry-run] [--rust]}; shift
DRY=0; EXTRA=""
for a in "$@"; do case $a in --dry-run) DRY=1;; --rust) EXTRA="--rust";; *) echo "unknown option $a"; exit 2;; esac; done
HERE=$(cd "$(dirname "$0")/.." && pwd); RX=$(cd "$HERE/.." && pwd); WS=$(cd "$RX/.." && pwd)
pin() { node -e "process.stdout.write(require('$HERE/pins.json')$1)"; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/rx-canary.XXXXXX")
echo "canary workspace: $TMP"
git clone -q --no-checkout "$RX" "$TMP/reactivescript"
git -C "$TMP/reactivescript" remote set-url origin "$(pin .reactivescript.repo)"
git -C "$TMP/reactivescript" remote set-url --push origin NO_PUSH
git -C "$TMP/reactivescript" fetch -q origin "$REV"
git -C "$TMP/reactivescript" checkout -q --detach FETCH_HEAD
COMMIT=$(git -C "$TMP/reactivescript" rev-parse HEAD)
NEXT=$(cat "$TMP/reactivescript/ref/SOLID_NEXT")
echo "candidate reactivescript $COMMIT (pin $(pin .reactivescript.commit))"
echo "candidate Solid $NEXT (pin $(pin .solid.commit))"
if [ $DRY = 1 ]; then echo "DRY RUN: no build or tests"; exit 0; fi
git clone -q --no-checkout "$WS/solid-next" "$TMP/solid-next"
git -C "$TMP/solid-next" remote set-url origin "$(pin .solid.repo)"
git -C "$TMP/solid-next" remote set-url --push origin NO_PUSH
export RUSTUP_TOOLCHAIN=$(pin .toolchain.rust)
(cd "$TMP/reactivescript" && sh ref/scripts/solid-next.sh > "$TMP/solid-build.log" 2>&1)
(cd "$TMP/reactivescript/ref" && npm ci > "$TMP/rx-install.log" 2>&1)
git -C "$RX" archive HEAD tsx-frontend | tar -x -C "$TMP/reactivescript"
(cd "$TMP/reactivescript/tsx-frontend" && npm ci > "$TMP/frontend-install.log" 2>&1)
(cd "$TMP/reactivescript/tsx-frontend" && OUT="$TMP/report" sh scripts/verify-pinned.sh --canary $EXTRA)
