# S-app-todos — TodoMVC against a server, in layers: server → failures → guesses

Rules exercised: ST-4, ST-5, AC-1, AC-3, AC-4, AC-7, H-11, R-f-6, W-6, D-34.

The layering of solid next's `examples/todos` (server → failures → guesses), written in .rx. Nothing keeps a copy of
what the server accepted: every action ends with `refresh server`, and its guesses stay until that answer lands.

## Program

file: ../examples/todos.rx

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading…` |
| 1 | resolve "loadTodos:" [{"id":"t1","title":"milk","done":false}] | `milk×1 leftallactivedone` |
| 2 | handler `add("t2", "eggs")` | `milk×eggs…×2 leftallactivedone` |
| 3 | handler `toggle("t1", true)` | `milk…×eggs…×1 leftallactivedoneclear done` |
| 4 | reject "toggleTodo:t1,true" "nope" | `milk…×eggs…×1 leftallactivedoneclear done` |
| 5 | resolve "addTodo:t2,eggs" 0 | `milk…×eggs…×1 leftallactivedoneclear done` |
| 6 | resolve "loadTodos:" [{"id":"t1","title":"milk","done":false},{"id":"t2","title":"eggs","done":false}] | `milkretry toggle×eggs×2 leftallactivedone` |
| 7 | handler `remove("t2")` | `milkretry toggle×1 leftallactivedone` |
| 8 | reject "removeTodo:t2" "nope" | `milkretry toggle×1 leftallactivedone` |
| 9 | resolve "loadTodos:" [{"id":"t1","title":"milk","done":false},{"id":"t2","title":"eggs","done":false}] | `milkretry toggle×eggsretry remove×2 leftallactivedone` |
| 10 | handler `filter := "done"` | `2 leftallactivedone` |

- 2: the add guesses `adding`, a list of its own, so it never joins a toggle's change (H-11).
- 3: the toggle guesses one row of `todos` (AC-3); `clear done` opens with the guess (a lane branch attaches now, H-7).
- 4: the save is declined. The catch records the failure (AC-7) and the body re-asks `server`. A re-ask issued by an
  action that guessed holds its change (D-34, AC-4): the guess stays up until the server's list lands, so the screen
  never shows the row reverted and then corrected.
- 5: the add is accepted. Its re-ask is the same question, still out: nothing moves.
- 6: the list lands. Both changes commit in one frame: `eggs` comes from the server (the add's guess goes in the same
  frame, so it is never shown twice), and `milk` is back to not done with its retry from the failures layer.
- 7–9: a declined remove: the row stays hidden until the list lands, then comes back with its retry.
- 10: `done` shows nothing: the failures are rows' state, not rows.

## What writing it found

1. `ref/` corrected an action's guesses at the end of its body even when the action had re-asked a question with
   `refresh` that was still out, unless the guess was on that question's own source. Solid holds the action's
   transition until the refresh lands. Fixed in `ref/src/runtime.ts`; AC-3's D-34 sentence now says so.
2. A guessed keyed source derived synchronously from a loaded equation (`source todos key id = server.map(…)`) was
   rebuilt instead of adopted on hydration: the runtime always handed `createOptimisticStore` an async derive. Fixed in
   `ref/compile/rt*.ts` (and so `@reactivescript/runtime`): the derive is async only when its value is.
3. Open, `ref/` only: a lane reader (H-7) computes from σ′ for every input, so it can show a plain write that is still
   held. A declined add whose action re-asks the list shows its retry while its guess is up (`jam` + `retry add`);
   Solid shows `jam…` until the list lands. The instants above avoid it.
