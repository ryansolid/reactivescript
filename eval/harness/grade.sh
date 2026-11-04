#!/bin/sh
# Grade one desk (scaffolded with `node harness/scaffold.mjs desk9 <arm> <dir> --brief plain [--inline-docs]`), however
# the agent that wrote it was run: hidden tests, hidden overlap tests, and 20 timing-fuzzer seeds.
# Usage: sh harness/grade.sh <desk dir> [out.txt]     (run from eval/; defects = ✗ lines + fuzz seeds with a hole)
set -e
d=$(cd "$1" && pwd); out=${2:-/dev/stdout}
cd "$(dirname "$0")/.."
{ echo "== hidden"; node harness/test.mjs "$d" tasks/desk9/hidden.mjs 2>&1 | grep "^✗\|passed\|build failed" || true
  echo "== overlap"; node harness/test.mjs "$d" tasks/desk9/hidden-overlap.mjs 2>&1 | grep "^✗\|passed\|build failed" || true
  echo "== fuzz"; node harness/fuzz.mjs "$d" --seeds 20 --r9 2>&1 | cut -c1-400; } > "$out"
