#!/bin/sh
# Rehearse another ReactiveScript revision without touching the pinned workspace. Everything happens in a fresh
# temporary directory: a clone of reactivescript at REV, Solid at that revision's ref/SOLID_NEXT, and an export of this
# package's committed HEAD with its own npm ci. Pins, baselines and working checkouts are never modified.
#   sh scripts/canary.sh REV --dry-run    cheap: fetch, report pin/schema changes; NO build and NO tests run
#   sh scripts/canary.sh REV [--rust]     full READINESS run: build Solid, install, run scripts/verify-pinned.sh --canary
#   sh scripts/canary.sh REV --compare    full run, COMPARISON ONLY against the unapproved observation (never "ready")
set -eu
REV=${1:?usage: canary.sh REV [--dry-run] [--rust]}; shift
DRY=0; EXTRA=""
for a in "$@"; do case $a in --dry-run) DRY=1;; --rust) EXTRA="$EXTRA --rust";; --compare) EXTRA="$EXTRA --compare";; *) echo "unknown option $a"; exit 2;; esac; done
HERE=$(cd "$(dirname "$0")/.." && pwd)
WS=$(cd "$HERE/.." && pwd)
pin() { node -e "process.stdout.write(require('$HERE/pins.json')$1)"; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/rx-canary.XXXXXX")
echo "canary workspace: $TMP"

git clone -q --no-checkout "$WS/reactivescript" "$TMP/reactivescript"
git -C "$TMP/reactivescript" remote set-url origin "$(pin .reactivescript.repo)"
git -C "$TMP/reactivescript" remote set-url --push origin NO_PUSH
if git -C "$TMP/reactivescript" cat-file -e "$REV^{commit}" 2>/dev/null; then
  COMMIT=$(git -C "$TMP/reactivescript" rev-parse "$REV^{commit}")
else
  git -C "$TMP/reactivescript" fetch -q origin "$REV"   # a branch name or a sha from the upstream remote (read-only fetch)
  COMMIT=$(git -C "$TMP/reactivescript" rev-parse "FETCH_HEAD^{commit}")
fi
PINNED=$(pin .reactivescript.commit)
SOLID_PIN=$(git -C "$TMP/reactivescript" show "$COMMIT:ref/SOLID_NEXT" | tr -d '[:space:]')
git -C "$TMP/reactivescript" fetch -q origin "$PINNED" 2>/dev/null || true
{
  echo "candidate reactivescript $COMMIT (pinned $PINNED)"
  echo "candidate ref/SOLID_NEXT $SOLID_PIN (pinned solid $(pin .solid.commit))$([ "$SOLID_PIN" = "$(pin .solid.commit)" ] && echo ' unchanged' || echo ' CHANGED')"
  echo "commits since pin: $(git -C "$TMP/reactivescript" rev-list --count "$PINNED..$COMMIT" 2>/dev/null || echo '?')"
  echo "-- contract surface changes (pinned..candidate):"
  git -C "$TMP/reactivescript" diff --stat "$PINNED" "$COMMIT" -- ref/src/ast.ts ref/src/model.ts ref/src/check.ts ref/src/infer.ts ref/src/parse.ts ref/src/modules.ts ref/src/failure.ts ref/compile/emit.ts ref/compile/jsx.ts ref/compile/rt.ts ref/compile/rt-web.ts ref/compile/rt-server.ts ref/compile/string-renderer.ts ref/package.json ref/SOLID_NEXT || true
  echo "-- exported names added/removed in adapter-facing modules:"
  for f in ref/src/ast.ts ref/src/model.ts ref/src/check.ts ref/src/infer.ts ref/src/parse.ts ref/compile/rt.ts; do
    git -C "$TMP/reactivescript" diff -U0 "$PINNED" "$COMMIT" -- "$f" | grep -E '^[-+]export ' | cut -c1-160 | sed "s|^|$f: |" || true
  done
} | tee "$TMP/dry-run.txt"
if [ $DRY = 1 ]; then
  echo "DRY RUN ONLY: no Solid build, install, type check or test was executed. Run without --dry-run for the full canary."
  exit 0
fi

git -C "$TMP/reactivescript" checkout -q "$COMMIT"
if ! sh "$HERE/scripts/apply-patches.sh" "$TMP/reactivescript" "$TMP/reactivescript-patched" > "$TMP/patch-queue.log" 2>&1; then
  cat "$TMP/patch-queue.log"; echo "PATCH QUEUE BREAKAGE: the temporary upstream patches no longer apply to $COMMIT (review each patch's removal condition)"; exit 1
fi
git clone -q --no-checkout "$WS/solid-next" "$TMP/solid-next"
git -C "$TMP/solid-next" remote set-url origin "$(pin .solid.repo)"
git -C "$TMP/solid-next" remote set-url --push origin NO_PUSH
# upstream's own build script: checks out ref/SOLID_NEXT in $TMP/solid-next and builds it (Rust for the compiler)
(cd "$TMP/reactivescript" && RUSTUP_TOOLCHAIN=$(pin .toolchain.rust) SOLID_NEXT="$TMP/solid-next" sh ref/scripts/solid-next.sh) > "$TMP/solid-build.log" 2>&1 \
  || { echo "UPSTREAM BASELINE FAILURE: Solid build failed (see $TMP/solid-build.log)"; exit 1; }
(cd "$TMP/reactivescript-patched/ref" && npm ci) > "$TMP/upstream-install.log" 2>&1 || { echo "UPSTREAM BASELINE FAILURE: npm ci in ref failed"; exit 1; }
mkdir -p "$TMP/frontend"
git -C "$HERE" archive HEAD | tar -x -C "$TMP/frontend"
(cd "$TMP/frontend" && npm ci) > "$TMP/frontend-install.log" 2>&1 || { echo "ADAPTER/API BREAKAGE: npm ci of the frontend failed (see $TMP/frontend-install.log)"; exit 1; }
set +e
(cd "$TMP/frontend" && OUT="$TMP/report" sh scripts/verify-pinned.sh --canary $EXTRA)
status=$?
echo "canary $(grep -m1 '^VERDICT' "$TMP/report/REPORT.md" 2>/dev/null || echo 'VERDICT: NOT READY (no report)'); report $TMP/report/REPORT.md, exit $status. Pins, manifest and observations in $HERE were not modified."
exit $status
