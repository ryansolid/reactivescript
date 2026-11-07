#!/bin/sh
# --subset checks the kept frontends and fixed fuzz run. The full check also gates on upstream exits.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
RX=$(cd "$HERE/.." && pwd -P)
SOLID=$(cd "$RX/../solid-next" && pwd -P)
OUT=${OUT:-$HERE/.out/verify}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
SUBSET=0; RUST=0; CANARY=0
for a in "$@"; do case $a in --subset) SUBSET=1;; --rust) RUST=1;; --canary) CANARY=1;; *) echo "unknown option $a"; exit 2;; esac; done
: > "$OUT/exits.txt"
record() { echo "$1 $2" | tee -a "$OUT/exits.txt"; }
pin() { node -e "process.stdout.write(require('$HERE/pins.json')$1)"; }
export RUSTUP_TOOLCHAIN=$(pin .toolchain.rust)
[ $CANARY = 0 ] || export RX_CANARY=1
pins=0
HEAD=$(git -C "$RX" rev-parse HEAD); SOLID_HEAD=$(git -C "$SOLID" rev-parse HEAD); NEXT=$(cat "$RX/ref/SOLID_NEXT")
# In-tree: only this demo package may differ from the upstream base.
BASE=$(pin .reactivescript.commit); [ $CANARY = 0 ] || BASE=$HEAD
[ -z "$(git -C "$RX" diff "$BASE" --name-only -- . ":(exclude)tsx-frontend")" ] || { echo "changes outside tsx-frontend/"; pins=1; }
[ -z "$(git -C "$RX" ls-files --others --exclude-standard | grep -v '^tsx-frontend/')" ] || { echo "untracked files outside tsx-frontend/"; pins=1; }
[ -z "$(git -C "$SOLID" status --porcelain --untracked-files=normal)" ] || { echo "Solid must be clean"; pins=1; }
[ "$SOLID_HEAD" = "$NEXT" ] || pins=1
if [ $CANARY = 0 ]; then
  git -C "$RX" merge-base --is-ancestor "$(pin .reactivescript.commit)" HEAD || pins=1
  [ "$SOLID_HEAD" = "$(pin .solid.commit)" ] || pins=1
fi
printf 'reactivescript %s\nSolid %s\n' "$HEAD" "$SOLID_HEAD" | tee "$OUT/pins.txt"
record pins $pins
cd "$HERE"
node --experimental-strip-types scripts/check-types.ts --out "$OUT"; record types $?
node --experimental-strip-types --conditions=browser --conditions=development --test \
  --test-reporter=spec --test-reporter-destination="$OUT/suite.spec.txt" \
  --test-reporter=./scripts/jsonl-reporter.mjs --test-reporter-destination="$OUT/suite.jsonl" tsx/*.test.ts yield/*.test.ts
record suite $?
node --experimental-strip-types --conditions=browser --conditions=development scripts/fuzz.ts --seeds 200 --start 0 --no-reduce > "$OUT/fuzz.log" 2>&1
record fuzz $?
cp .out/fuzz/run-0-200/summary.json "$OUT/fuzz.json"
if [ $SUBSET = 0 ]; then
  for s in test oracle compiled types ssr; do
    (cd "$RX/ref" && NODE_PATH="$HERE/node_modules" npm run -s "$s" > "$OUT/upstream-$s.log" 2>&1); record upstream-$s $?
  done
fi
if [ $RUST = 1 ]; then
  for m in check lower project; do
    arg=""; [ "$m" = check ] || arg="--$m"
    (cd "$RX/ref" && npm run -s crate -- $arg > "$OUT/rust-$m.log" 2>&1); record rust-$m $?
  done
  (cd "$RX/compiler" && cargo test --release > "$OUT/rust-test.log" 2>&1); record rust-test $?
fi
node --experimental-strip-types scripts/report.ts --out "$OUT" "$@"
