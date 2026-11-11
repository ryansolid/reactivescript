# S-ai2-tracker — an issue tracker over four modules

Rules exercised: MO-1b, MO-2a, MO-2b, MO-7, RG-1a, RG-1b, RG-1c, RG-2, RG-7b,
RG-7e, ST-4, ST-5, E-11, R-1, R-6, R-f-3, R-f-4, R-f-5, R-f-6, H-5, H-6, H-11,
H-12, AC-1, AC-3, AC-4, AC-7, W-3.

## Program

file: ../examples/ai2/tracker/main.rx

## Frames

| instant | action | frame | effect / probe verdicts |
| ------- | ------ | ----- | ----------------------- |
| 0 | mount | `open closed loading open issues / select an issue` | — |
| 1 | resolve "fetchIssues:open" [{"id":1,"title":"Login fails","assignee":null},{"id":3,"title":"Crash on save","assignee":null},{"id":4,"title":"Typo in footer","assignee":"dana"}] | `open closed #1 Login fails (unassigned) #3 Crash on save (unassigned) #4 Typo in footer (dana) / select an issue` | — |
| 2 | handler `select(3)` | `open closed #1 Login fails (unassigned) #3 Crash on save (unassigned) #4 Typo in footer (dana) / loading #3 retry assign to guest` | — |
| 3 | resolve "fetchIssue:3" null | `open closed #1 Login fails (unassigned) #3 Crash on save (unassigned) #4 Typo in footer (dana) / detail error: issue #3 not found retry assign to guest` | — |
| 4 | handler `refresh detail` | `open closed #1 Login fails (unassigned) #3 Crash on save (unassigned) #4 Typo in footer (dana) / detail error: issue #3 not found retry assign to guest` | — |
| 5 | resolve "fetchIssue:3" {"id":3,"title":"Crash on save","body":"stack trace attached"} | `open closed #1 Login fails (unassigned) #3 Crash on save (unassigned) #4 Typo in footer (dana) / #3 Crash on save stack trace attached retry assign to guest` | — |
| 6 | handler `signIn("ann")` | `open closed #1 Login fails (unassigned) #3 Crash on save (unassigned) #4 Typo in footer (dana) / #3 Crash on save stack trace attached retry assign to ann` | — |
| 7 | handler `assignToMe(3, "ann")` | `open closed #1 Login fails (unassigned) #3 Crash on save (ann) #4 Typo in footer (dana) / #3 Crash on save stack trace attached retry assign to ann` | — |
| 8 | reject "assign:3,ann" "declined" | `open closed #1 Login fails (unassigned) #3 Crash on save (unassigned) #4 Typo in footer (dana) / #3 Crash on save stack trace attached retry assign to ann declined` | — |
| 9 | handler `setFilter("closed")` | `open closed loading closed issues / #3 Crash on save stack trace attached retry assign to ann declined` | — |
| 10 | reject "fetchIssues:closed" "timeout" | `open closed list error: timeout / #3 Crash on save stack trace attached retry assign to ann declined` | — |
| 11 | handler `select(1)` | `open closed list error: timeout / loading #1 retry assign to ann` | — |

- 0: `issues` is pending on `fetchIssues:open`. Its readers sit under `loading on(filter)`, which has not shown content yet (armed), so the boundary takes them and shows its fallback, and the mount is not held (H-5). `selected` is null, so the `else` branch shows (RG-1). The only flight is `fetchIssues:open`; `detail` takes the null arm and opens none (E-11).
- 1: the answer lands, the keyed `for` creates three rows, and the boundary is now disarmed (H-6). `null ?? "unassigned"`.
- 2: `select` is an action with no `await`, so its change is an ordinary instant (AC-1). `selected` goes null→3, which creates the `if` branch fresh (RG-1a). Its new `loading` is armed and takes the `detail` readers pending on `fetchIssue:3` (H-5). The buttons outside it show now, and `use currentUser` reads main's provision, `session` = "guest" (RG-7b). `assignError` is "", which trims away.
- 3: `fetchIssue:3` answers null, so `found` throws `NotFound(3)` (R-f-3). That error is an answer, so the detail's `errored` shows its fallback inside the loading content (H-12). The list never reads `detail` and is untouched.
- 4: `refresh detail` re-asks `fetchIssue:3` quietly under the same key (AC-4, MO-2b). An `errored` on its fallback stays there while the content under it is pending (H-12), so the frame does not change.
- 5: the fresh flight lands a value, the value replaces the error, and the content shows (H-12, R-6).
- 6: `signIn` writes `session`, which is the provision's value, so `me` follows it (RG-7b). The assign label changes.
- 7: the guess is a root functional write over the question source `issues` (AC-3). Its readers are in lane `issues` and show it now (H-11). Keyed reconcile keeps row #3 and updates only its `assignee` (ST-4). The plain write `assignError := ""` equals the current value and is held with the action anyway. `assign:3,ann` is in flight.
- 8: the rejection throws at the `await`, and the `catch` writes `assignError`. That is inside the action, so it is the same change (AC-7). The body ends and the change commits. Committing ends the guess, and the truth is the original list, so #3 is unassigned again, in the same frame as "declined" (H-11, AC-1/DV-2).
- 9: `filter` changes, so the question source `issues` asks `fetchIssues:closed` (ST-5a, R-4). `loading on(filter)` re-arms with readers pending and shows its fallback in this frame. The fallback's `{filter}` reads "closed" (H-6). The detail panel reads nothing that changed.
- 10: the list's flight is rejected, `issues` holds an error value, and the list's `errored` takes the region holding the `loading` (H-12, R-6). The detail panel is still shown and unchanged, so the failure stays in one panel (requirement 3).
- 11: `select(1)` changes `selected` 3→1. The value is truthy both times, so the branch stays (RG-1b). `loading on(selected)` re-arms with `detail` pending on `fetchIssue:1` and shows "loading #1" (H-6). The same action clears `assignError` in the same instant (W-3). The list's error stays where it is.

## Rejected variants

Predicted from the spec and not run (the test allows the checker only on `main.rx`):

| fragment | rule | verdict |
| -------- | ---- | ------- |
| delete the `errored fallback(e) { … }` wrapper in `DetailPanel` | R-f-5 | `UNHANDLED_FAILURE` (`detail` fails `Error` or `NotFound`) |
| in `assignToMe`, `await assign(id, user)` outside `try … catch` | R-f-6 | `UNCAUGHT_ACTION_FAILURE` |
| in `ui.rx`, a handler `() => { selected := issue.id }` | MO-2a | `WRITE_TO_NON_SOURCE` |
| `guess assignError := "…"` in an action (`assignError` is `:=`, no question) | AC-3 / ST-5c | `GUESS_NO_QUESTION` |
