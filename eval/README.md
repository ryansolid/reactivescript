# eval — is .rx worth it for AI-written code?

A benchmark where the same agent builds the same apps once in ReactiveScript and once in React 19, and both are
judged by the same browser tests. The plan, and why React is the control:
[Proving ReactiveScript for AI](https://claude.ai/artifact/1MZdLdGa6WmmNiBWpLyGyK).

This file is the **pilot's pre-registration**: everything below was fixed and committed before the first agent run.

## Arms

| | React (control) | .rx |
| --- | --- | --- |
| Stack | React 19.2, TypeScript 5.9 strict, `@tanstack/react-query` 5 available | ReactiveScript over Solid 2.0.0-rc.19 |
| `./check` | `tsc --noEmit` + ESLint with `eslint-plugin-react-hooks` 7 recommended (includes the React Compiler rules) | `rxc check src/main.rx` (the crate from PR #6, built against Solid rc.19 = solidjs/solid d2323b0) |
| Docs given | none (the model knows React) | `spec/` as `docs/spec` (as in the `examples/ai`, `examples/ai2` tests) |
| Mounted by | `createRoot` under `StrictMode` | `createApp` from `ref/compile/rt-web.ts` |
| Built with | Vite 7 + `@vitejs/plugin-react` | `rxc compile` → Vite 7 |

Both arms get the same brief, the same `src/api.js` and the same visible tests, through the same prompt
(`harness/prompt.md`, with `harness/prompt-arms.json` filling in the language). No arm sees the hidden tests.

## Tasks

The three apps of `examples/ai2`, rewritten as product briefs that name no framework: `tasks/<task>/brief.md`.

| Task | What it stresses | Visible tests | Hidden tests |
| --- | --- | --- | --- |
| `search` | search as you type, a detail pane, answers out of order, not found, failure and retry | 4 | 12 |
| `tracker` | a filtered list, a detail, an optimistic assignment that the server can decline | 4 | 11 |
| `settings` | load with retry, a draft form, an optimistic save that can fail, edits during a save | 4 | 8 |

Every API call is a *flight* (`harness/flights.js`) that stays in the air until the test lands or fails it, so a
test decides the order answers arrive in. Hidden tests are the adversarial orders: a stale answer or failure
arriving after a newer one, a save failing after an optimistic update, edits made while a save is in flight.

Tests assert only what a user sees, through the `data-testid`s and texts the brief names.

**Validated before freezing** (`node harness/test.mjs <dir> tasks/<task>/hidden.mjs`):

- Both references pass every visible and hidden test: `reference/<task>/rx` (the `examples/ai2` app, with the
  brief's test ids) and `reference/<task>/react` (TanStack Query, written for this).
- A plausible naive React draft per task (`mutants/<task>/react-naive.tsx`: effects that fetch without
  cancellation, a rollback to the wrong value, a form that re-seeds) passes **every visible test** and fails hidden
  ones: search 4 of 12, tracker 3 of 11, settings 5 of 8. That gap is what the benchmark measures.

Hidden test files, SHA-256 at freezing:

```
1d77a1daa81d15d40045d1f4665f9fdcebbe9abb6356db5b3a6eb8b29d30d0ae  tasks/search/hidden.mjs
c02e80f9b64e44dd843b601713ddc67553a5f85835e36ee5d13c35fb4121d09e  tasks/tracker/hidden.mjs
58d2a1daa4a1b8d2ea559ab56bb37ee9193dcf3d31d03e362107e25ee3b106b6  tasks/settings/hidden.mjs
```

## Runs and metrics

- 3 tasks × 2 arms × 3 runs = 18 runs, one model (Claude, the session's frontier model), each run a fresh agent with
  no memory of the others, in its own directory (`harness/scaffold.mjs`).
- Budget: 15 `./check` + `./test` runs per agent. The agent stops when it says it's done.
- **Headline: defects shipped** — share of runs, at the agent's "done", where the build fails or any visible or
  hidden test fails.
- Also: hidden tests passed; `./check`+`./test` cycles until the visible tests first passed (from `.runlog`);
  `./check` clean at the end (reported, not counted as a defect); each failed hidden test, classified by hand
  afterwards (stale answer, lost rollback, draft reset, stuck state, wrong text).
- `node harness/score.mjs <runs-dir>` scores; results go to `results/`.

## Known limits of the pilot

- **Isolation is by instruction.** Agents share a machine with this repo (including `examples/ai2`, the .rx
  solutions). The prompt forbids reading outside the run directory; a published run needs separate containers.
- **The .rx arm has no type checker in the loop.** `rxc check` checks the language; the TypeScript projection (13)
  is not in the crate. React gets `tsc`.
- **The .rx docs are the spec**, 35k words written for implementers. There is no tutorial yet. Some spec notes name
  the ai2 scenarios in passing.
- **One Solid bug is live in rc.19 and touches `search`:** DV-8 (solidjs/solid#4271): a keyed projection
  (`results key id = …`) reports no `pending?` while its memo re-asks, so `searching…` doesn't show. The .rx
  reference drops `key id` for this reason. A .rx run failing a `searching…` test only because of `key` is
  reported as *runtime bug*, separately from agent defects.
- 3 runs per cell gives an effect size, not a significance test. That is the pilot's purpose.

## What validating the references found (before any agent ran)

Two of the three `examples/ai2` apps needed a change to meet their own briefs. The agents that wrote them
predicted every frame right; the briefs here are stricter.

- `search`: DV-8 above.
- `tracker`: `assignToMe` cleared its error with a plain write (`assignError := ""`) inside an action that awaits,
  and a plain write in an async action is held until the action ends (AC-1), so the old error stayed up until the
  server answered. The fix is the `settings` app's own idiom: `assignError` a question source,
  `guess assignError := ""` (since 2026-11-11 the references clear errors with `onFlush`, EF-8).

## Layout

```
harness/   flights.js (the fake backend), build/test/driver (Vite + Playwright), check, scaffold, agent-cli, score, prompt
tasks/     <task>/brief.md, api.js, api.d.ts, api.d.rx, fixtures.mjs, visible.mjs, hidden.mjs
reference/ <task>/{rx,react}: solutions that pass every test
mutants/   naive React drafts the hidden tests must catch
results/   scored runs
```

Setup: `npm install` here (Solid 2.0.0-rc.21 and Playwright from npm; set `CHROMIUM=/path/to/chromium` to drive a
system browser instead of Playwright's download); `cargo build --release --bin rxc` in `../compiler` (its Solid pin
is `ref/SOLID_NEXT`). A round is regradable only if its runs' sources are committed under `results/<round>/runs/`
(rounds 5, 7, 10 and 11 kept theirs in the session that ran them and cannot be regraded).
`RXC` and `RT_WEB` override the paths to the binary and `ref/compile/rt-web.ts`. (The pilot itself ran on PR #6's
crate before it merged, built with the same pin.)

## Running another agent harness (Cursor, Grok, Codex, …)

A desk is a self-contained folder: `node harness/scaffold.mjs desk9 rx <dir> --brief plain --inline-docs` writes
`.prompt` (the whole instructions), `BRIEF.md`, `src/`, `./check` and `./test`. Give the agent `.prompt` as its task
and the folder as its workspace, then grade with `sh harness/grade.sh <dir>`. Use the `react` arm for the control.
Defects are comparable across harnesses; cost needs that harness's own token count (`cost.mjs` reads Claude
transcripts). The hidden tests and references are in this public repo: an outside run relies on the prompt's
"don't look elsewhere" rule, so check its transcript.
