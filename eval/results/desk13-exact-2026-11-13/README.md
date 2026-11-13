# desk9 in Exact, Opus, 3 apps, our harness (2026-11-13)

Not preregistered. The `contract` arm (ported from expo/exact's bench patch, #59) run the way we ran the .rx probe:
Opus as general-purpose subagents, `--brief plain --inline-docs` (Exact's `docs/start-here.md` inlined, the rest of
its docs readable), `./check`/`./test` as the only build feedback (15 runs). Exact at main 8c742e6a, from a
`git archive` with `bench/` removed, so agents could not read Exact's own desk9 reference.

| app | hidden | overlap | fuzz holes | defects | lines (non-blank, non-comment) | subagent tokens | minutes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| contract-1 | 77 | 37 | 0 | 1 | 605 | 155k | 12.4 |
| contract-2 | 76 | 37 | 0 | 2 | 568 | 145k | 11.4 |
| contract-3 | 77 | 38 | 0 | **0** | 605 | 168k | 10.5 |

Mean **1.0**. For comparison, the last three .rx apps (rx-7..9, same harness, guide with the lifetime rule, Solid
next f00ce6f52) score 2, 0, 0 = **0.67**, at 99-107k tokens, about 5 minutes and 411-452 lines each. Three apps per
arm: neither difference means anything statistically.

## The defects

- **Settings save, contract-1 and contract-2** (overlap "a later save failing while an earlier one is out shows its
  error and then the earlier result"). Every issue write is a `parallel` mutation, but both apps left
  `mutation saved` on Exact's default mode, under which a later save replaces the earlier one, so the earlier
  result never shows. contract-3 declares no such mutation for its save.
- **contract-2, "rows: row errors and detail errors leave each other alone"**: row actions and the detail share an
  error path (agent).

No fuzz holes in any Exact app.
