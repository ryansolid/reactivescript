#!/bin/sh
# Verification of the pinned stack. Every step's process exit code is recorded in $OUT/exits.txt and judged by
# scripts/report.ts; nothing is inferred from log tails.
#   sh scripts/verify-pinned.sh [--compare] [--skip-upstream] [--rust] [--canary]
# default      READINESS: exits 0 only if pins match, types are clean, every suite and browser test passes, the whole
#              coverage manifest ran, and the upstream runners ran and match their pinned summaries.
# --compare    COMPARISON ONLY: exits 0 when the run reproduces baselines/observed-failures.json (an unapproved
#              observation of the migration's current failures and coverage gaps). The report still says NOT READY.
# --skip-upstream  skip upstream runners (never READY then); --rust adds the crate parity runners;
# --canary     used by scripts/canary.sh: pins may differ from the checkout (reported, not enforced).
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
RX=$(cd "$HERE/upstream" && pwd -P)
SOLID=$(cd "$RX/../solid-next" && pwd -P)
OUT=${OUT:-$HERE/.out/verify-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"; : > "$OUT/exits.txt"
MODE=ready; SKIP_UPSTREAM=0; RUST=0; CANARY=0
for a in "$@"; do case $a in --compare) MODE=compare;; --skip-upstream) SKIP_UPSTREAM=1;; --rust) RUST=1;; --canary) CANARY=1;; *) echo "unknown option $a"; exit 2;; esac; done
[ $CANARY = 1 ] && export RX_CANARY=1
record() { echo "$1 $2" >> "$OUT/exits.txt"; echo "step $1 exit $2"; }

pin() { node -e "process.stdout.write(require('$HERE/pins.json')$1)"; }
RX_HEAD=$(git -C "$RX" rev-parse HEAD); SOLID_HEAD=$(git -C "$SOLID" rev-parse HEAD); SOLID_NEXT=$(cat "$RX/ref/SOLID_NEXT")
{
  echo "reactivescript $RX_HEAD (pin $(pin .reactivescript.commit))"
  echo "ref/SOLID_NEXT $SOLID_NEXT; solid checkout $SOLID_HEAD (pin $(pin .solid.commit))"
  echo "node $(node --version); rustc $(RUSTUP_TOOLCHAIN=$(pin .toolchain.rust) rustc --version 2>/dev/null)"
} | tee "$OUT/pins.txt"
pins=0
# The upstream tree may differ from its commit only by exactly the declared patch queue (patches/README.md).
QUEUE=$(cat "$HERE"/patches/[0-9][0-9][0-9][0-9]-*.patch 2>/dev/null || true)
if [ "$(git -C "$RX" diff)" != "$QUEUE" ] || [ -n "$(git -C "$RX" status --porcelain --untracked-files=normal | grep -v '^ M ' || true)" ]; then
  echo "MISMATCH: upstream tree differs from its commit by more or less than the patch queue"; pins=1
else
  echo "upstream tree = commit + patch queue ($(ls "$HERE"/patches/[0-9][0-9][0-9][0-9]-*.patch 2>/dev/null | wc -l | tr -d ' ') patches)"
fi
[ "$SOLID_HEAD" = "$SOLID_NEXT" ] || { echo "MISMATCH: solid checkout is not ref/SOLID_NEXT"; pins=1; }
if [ $CANARY = 0 ]; then
  [ "$RX_HEAD" = "$(pin .reactivescript.commit)" ] || { echo "MISMATCH: reactivescript is not the pinned commit"; pins=1; }
  [ "$SOLID_HEAD" = "$(pin .solid.commit)" ] || { echo "MISMATCH: solid is not the pinned commit"; pins=1; }
fi
record pins $pins

cd "$HERE"
node --experimental-strip-types scripts/check-types.ts --out "$OUT"; record types $?
node --experimental-strip-types --conditions=browser --conditions=development --test \
  --test-reporter=spec --test-reporter-destination="$OUT/suite.spec.txt" \
  --test-reporter=./scripts/jsonl-reporter.mjs --test-reporter-destination="$OUT/suite.jsonl" tsx/*.test.ts
record suite $?
node --experimental-strip-types --test \
  --test-reporter=spec --test-reporter-destination="$OUT/browser.spec.txt" \
  --test-reporter=./scripts/jsonl-reporter.mjs --test-reporter-destination="$OUT/browser.jsonl" tsx/browser.ts
record browser $?

if [ $SKIP_UPSTREAM = 0 ]; then
  for s in test oracle compiled types ssr; do
    (cd "$RX/ref" && NODE_PATH="$HERE/node_modules" npm run -s $s > "$OUT/upstream-$s.log" 2>&1); record upstream-$s $?
  done
  if [ $RUST = 1 ]; then
    for m in "" --lower --project; do
      (cd "$RX/ref" && RUSTUP_TOOLCHAIN=$(pin .toolchain.rust) npm run -s crate -- $m > "$OUT/crate$m.log" 2>&1); record crate$m $?
    done
  fi
fi

node --experimental-strip-types scripts/report.ts --out "$OUT" --mode $MODE --proposal "$OUT/proposed-observation.json"
status=$?
echo "report: $OUT/REPORT.md (mode $MODE, exit $status)"
exit $status
