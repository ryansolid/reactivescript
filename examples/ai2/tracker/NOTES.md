# NOTES — tracker (ai2)

Files: `main.rx` (entry: provides the user, lays out the panels),
`people.rx` (the `currentUser` context, the session, `signIn`),
`issues.rx` (filter, list, selection, detail, assignment state and the actions
that write them), `ui.rx` (`IssueList`, `DetailPanel`).

## Checker runs: 4

| # | command | diagnostics | did the message alone tell me the fix? | change |
| - | ------- | ----------- | -------------------------------------- | ------ |
| 1 | `check.ts …/main.rx` | parse error, no code: `ui.rx: line 7: props name near ') {'` | Mostly. "props name" plus the location told me a component must name its props parameter. I checked 07 §9 (`"component" Name "(" Name Type? ")"`) to be sure the name is mandatory and not just the type. | `component IssueList()` → `component IssueList(props: {})`, and the same for `DetailPanel`. |
| 2 | same | none (`ok … (+3 modules)`) | — | — |
| 3 | `--signature` | none | — | Nothing. I checked the rows: `issues: pending fails(Error)` (a question), `detail: pending fails(Error \| NotFound)`, both components with nothing escaping, `currentUser: string = …`. All as intended. |
| 4 | same | none | — | Re-check after changing main's panel separator from `" \| "` to `" / "` (a `\|` inside a scenario table cell would need escaping). |

So the only diagnostic I hit was a parse error. None of the static codes fired:
not UNHANDLED_FAILURE, UNCAUGHT_ACTION_FAILURE, WRITE_TO_NON_SOURCE,
UNSTABLE_LIST_IDENTITY or SNAPSHOT_*. I had written each discharge on purpose:
an `errored` per panel, a `try/catch` in the one awaiting action, `key id` on
the list, and actions as the only writers.

## What the checker (or the language) made me write that I don't like

- **`props: {}` on components that take no props** (run 1). It is noise: the
  name is never read, and the grammar could accept `()` the way `fn` does.
  This is the one thing the checker actually forced on me.
- **The default user is written twice.** `context currentUser: string = "guest"`
  is the default, and `source session := "guest"` is the session that main
  provides. A provider can't say "fall back to the context's default", so the
  session has to repeat it. I see three alternatives, all worse: provide
  nothing (then `provide` and the session are pointless); a nullable session
  with `provide currentUser = session ?? "guest"` (the same duplication); or
  provide conditionally (`if session { provide …; <App/> } else { <App/> }`),
  which recreates the app on sign-in (RG-1a).
- **Plain setters must be actions** (`setFilter`, `select`). This is the rule
  I was given (MO-2a: actions are the write interface), and I agree with it.
  The cost is that an `action` is defined by its hold (AC-1), so a one-line
  setter's semantics depend on how AC-1's "everything it put in flight" is
  read (see Ambiguities 1). I'd want either a sync action to be stated to be
  an ordinary instant, or a lighter exported-setter form.
- **The truth after a successful assign repeats the guess.**
  `guess issues := f` followed later by `issues := f` with the same `f`.
  H-11 makes this necessary: without the plain write, the guess is "corrected
  by the truth at hand" when the body ends, which reverts a successful
  assignment. The ideal is `refresh issues` (the server is the truth), but
  that adds a round trip and holds the action until `fetchIssues:open` lands
  again. I chose the local truth (07 §5's `placeOrder` idiom) and note it.
- **Truthiness narrowing.** `if selected { … }` narrows (RG-1c), but an issue
  with id `0` would read as "nothing selected". `if selected != null` is what
  I'd write, but compound conditions narrow nothing, and inside the branch I
  need `selected` as a `number` (for `loading on(selected)` and the assign
  handler). I kept the bare name and rely on ids starting at 1.
- **`{" "}` separators** in the markup. These come from the frame-text rule
  (adjacent elements add no separator, TEMPLATE.md), not the checker. A real
  UI wouldn't need them, but here they make the frames readable.
- **Not forced, but worth saying:** the checker did not make me write any
  `catch` I didn't want. The `try/catch` in `assignToMe` is how the server's
  message reaches the panel, so I'd write it anyway. And with no root
  `errored`, a panic (a sync JS throw) halts the app. That is deliberate,
  since each panel discharges its own failures.

## Ambiguities / places the spec is silent, and what I assumed

1. **Does an action with no `await` hold until the flights its writes cause
   have landed?** AC-1 says the change is "held until the body returns and
   everything it put in flight has landed". `select(3)` puts nothing in flight
   itself, but its write makes `detail` ask `fetchIssue:3`. I assumed
   "put in flight" means the body's own awaits and refreshes, so a sync action
   is an ordinary instant (H-2): the new `loading` shows its fallback at once.
   MO-2a's own example (`export action select(id) { selected := id }`) only
   makes sense this way. If the other reading is right, the fallbacks in
   frames 2, 9 and 11 never appear (H-5: "possibly never, if that frame is
   itself held") and those frames keep the previous screen.
2. **Whitespace between elements on separate lines.** I assumed JSX's rule:
   whitespace that contains a newline is dropped, and same-line spaces are
   kept. TEMPLATE.md says "adjacent elements add no separator" without saying
   whether a newline between them is a text node. I avoided depending on it
   by using `{" "}` everywhere a separator matters. One left-over risk: the
   trailing `{" "}{assignError}` with `""` relies on the final trim.
3. **`provide` at the entry module's top level.** RG-7 says "in a component's
   block"; 03 RG-7b says "in a region". The checker accepted it at main's top
   level, and I assumed the program root is a region whose provisions reach
   every component it applies.
4. **`refresh detail` across a module, on an equation whose `await` is
   nested.** `detail` is `selected == null ? null : found(await fetchIssue(selected), selected)`.
   AC-4 allows "an `await` equation" and MO-2b allows refreshing an imported
   question. Whether a nested `await` makes `detail` "an await equation" is not
   stated. The checker accepted it. I assumed the re-ask re-runs the
   `fetchIssue` flight under the same key.
5. **`loading` outside or inside `errored`.** I put the detail's `loading
   on(selected)` outside its `errored`. The case I care about is selecting
   another issue while the detail shows an error. H-12 says an `errored` on
   its fallback stays there while the content under it is pending. H-4 says
   readers behind a fallback hold nothing. H-6 says `on` re-arms "if a reader
   under it is pending". Whether readers behind an `errored` fallback count as
   pending readers under the outer `loading` is not stated. I hoped the
   re-arm would show "loading #n" rather than a stale error, but I kept that
   case out of the frames. With the opposite nesting, H-12 says the stale
   error would stay up until the new issue lands.
6. **An action whose only plain write is equal, plus a guess** (frame 7).
   W-3 says a run whose writes all equal their slots opens no instant. The
   guess is a write that is not equal, so I assumed the instant opens and the
   lane reveals now.
7. **Importing the same JS module twice**, `import pure { fetchIssues,
   fetchIssue }` and `import { assign }` from `"./api"`, so that only `assign`
   is `io`. The spec doesn't say whether one import line can mix rows. Two
   lines were accepted.
8. **The detail doesn't show the assignee.** After an assignment, `detail`
   (from `fetchIssue`) would be stale, and nothing in the requirements re-asks
   it. I show assignees only in the list, which is the optimistic state.
   `refresh detail` in the action's success path would fix it, at the cost of
   holding the action until that lands.
9. **Scenario value syntax.** I assumed `resolve "key" v` takes JSON
   (`null`, objects, arrays). The flight keys follow the task's format:
   `fetchIssues:open`, `fetchIssue:3`, `assign:3,ann`.
10. **One flight per key.** Toggling the filter back to `open` would issue
    `fetchIssues:open` a second time, which the harness forbids. The program
    does that naturally, so the scenario avoids the toggle; it isn't something
    the program should avoid.

## Confidence per predicted frame

| instant | confidence | rule(s) relied on |
| ------- | ---------- | ----------------- |
| 0 mount | high | H-5 (armed `loading` takes pending readers; mount not held), E-11 (null arm opens no flight), RG-1 |
| 1 list lands | high | R-1, RG-2/ST-4 keyed rows, H-6 (now disarmed) |
| 2 `select(3)` | medium | RG-1a (fresh branch, fresh armed boundary), H-5, RG-7b. Risk: Ambiguity 1 (sync action holding) |
| 3 detail `null` | high | R-f-3 (`throw NotFound` in `found`), H-12 (an error is an answer → fallback), R-f-1 message |
| 4 `refresh detail` | medium | AC-4 (quiet re-ask), H-12 ("the error stays the display through a retry"; a fallback stays while content pends) |
| 5 detail lands | high | H-12 ("leaves only when a value replaces the error"), R-6 |
| 6 `signIn("ann")` | high | RG-7b (`use` tracks the provision; the provision is `session`) |
| 7 `assignToMe` | medium | AC-3/H-11 (guess shows now in lane `issues`), ST-4 (keyed path update), Ambiguity 6 |
| 8 assign rejected | medium | AC-7 (catch is the same change), H-11 (commit ends the guess; truth is the original list), AC-1/DV-2 (plain writes commit) |
| 9 `setFilter("closed")` | medium | ST-5a (question re-derives), H-6 (`on` re-arm shows the fallback with this change's frame), Ambiguity 1 |
| 10 list rejected | high | R-6, H-12 (list `errored` takes the region holding its `loading`); detail independent since nothing there reads `issues` |
| 11 `select(1)` | medium | RG-1b (truthy→truthy keeps the branch), H-6 re-arm, W-3 (`assignError` cleared in the same instant), Ambiguity 1 |

Every frame also carries the whitespace assumption (Ambiguity 2), and that
risk is the same for all of them.
