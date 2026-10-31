# Async in .rx: read this before writing any

This is the one page to read before you write code that talks to a server. The rules it cites are in `spec/`; you
don't need them to follow it.

## Rule zero: don't track requests yourself

Don't write sequence numbers, request ids, "latest token" checks, `if (stillCurrent)` guards, cancellation flags,
or lists of pending requests. In .rx those are bugs waiting to happen, and they are never needed. The language
already knows which question is current and which change a write belongs to. If you're reaching for a counter, you
want one of the moves below.

## 1. Reading from the server: an equation

```
forecast = city == "" ? null : city.length < 3 ? throw TooShort(city) : await fetchForecast(city)
```

- It is asked again whenever its inputs change. An answer to an older question is thrown away when it lands
  (R-4), so a stale answer can never show. Nothing to guard.
- An arm that isn't taken asks nothing (E-11): the empty and the too-short city send no request.
- While a new answer is on its way, everything that reads `forecast` keeps showing the last one (the change is held,
  H-2). To show that work is going on, read ahead: `pending? forecast` is `true` while it's in flight, and
  `latest city` is what was typed.
- The first load has nothing to show yet: wrap the readers in `loading fallback { <p>loading…</p> } { … }`. To
  show the fallback again each time a key changes (a new selection, not a refinement), use `loading on(selected)`.

## 2. Failures: a boundary or a value

- `errored fallback(e) { <p>failed: {e.message}</p> } { … }` shows a failure in place of the content under it.
  Give each pane its own, so one pane's failure never touches another.
- `x catch (e) => e.message` turns a failure into a value, for showing it inline.
- An answer that means "missing" (`null`) is a failure you declare: `export error NotFound(id: number) => …`, and
  `found(await fetchUser(id), id)` with `fn found(it, id) => it == null ? throw NotFound(id) : it`.
- Retry is `refresh x`. It is quiet (AC-4): the failure stays on screen until the new answer replaces it (H-12).

## 3. Writing to the server: an action

```
export source profile: Profile = await loadProfile()   // a source with a question: it can take a guess
export source saveError: string = ""

export action save(next: Profile) {
  optimistic profile := next        // shows now; reverts by itself if the save fails
  optimistic saveError := ""        // the old error goes now
  affects profile                   // `pending? profile` is true until the save ends
  try {
    let answer = await saveProfile(next)
    profile := answer               // the truth
  } catch (e) {
    saveError := e.message          // lands in the same frame as the revert
  }
}
```

A handler can be the action itself, with no keyword: an arrow that writes `optimistic`, declares `affects`, or both
writes and awaits is an action (AC-1b). Declare a named `action` when you call it from more than one place.

An action's body is **one change**: every plain write in it, before or after an `await`, is held until the body
returns (AC-1). That is what makes it safe, and it is why a plain write there doesn't show at once. Pick the write
by what the screen should do:

| You want | Write |
| --- | --- |
| Show a value now, and take it back if the action fails | `optimistic x := v` (x is a source with a question: `source x = …`) |
| `pending? x` true while the action runs | `affects x` |
| Land a UI write now and keep it (close a menu, clear a message) | `onFlush(() => { x := v })` (EF-8) |
| Record the server's answer | `x := answer` after the `await` |
| Handle a failure | `try { … } catch (e) { … }`: the catch's writes and the revert are one frame (AC-7) |

### Writing one row of a list

When several actions can each change a different row of one list, guess the row, not the list:

```
export source todos: Todo[] key id = await loadTodos()

export action markDone(id: number) {
  try {
    let i = todos.findIndex(t => t.id == id)  // -1 when absent
    optimistic todos[i].done := true          // this row only
    await saveDone(id)
    refresh todos                             // the server's list confirms the guess
  } catch (e) { … }
}
```

Guessing the row changes only that row on screen, and a new answer for the list corrects only the rows that differ
(AC-3). After the `await`, re-ask the list (`refresh todos`) rather than writing the row: a plain write to a list that
is guessed by row is not supported yet.

### When a declined guess waits

A row guess belongs to its action: when the action ends (accepted or declined), the row shows the truth again,
even while other actions on the same list are still out. The exception is a re-ask. A keyed source with a question
is one projection of its answer, and a new answer can touch every row, so while an action's `refresh todos` is in
flight, everything shown from `todos` waits for that action to end, including another action's declined guess.
The screen is never wrong in between: it shows the guesses, then the truth, in one frame. This is the design (H-11),
not a bug, and moving the guess to a source of its own doesn't change it: the rows that show it read `todos`.

A guess on a whole list (`optimistic adding := as => [...as, x]`) is one change with every other guess on that list:
two adds in flight end together, so a declined one stays until the other ends. That's the same rule, not something
to work around.

- **Show that something is in flight**, so the longer wait isn't silent: a row flag set by the guess
  (`optimistic todos[i].saving := true`), or `pending? todos` with `affects todos`.
- **Don't rebuild guesses by hand** (a plain list of pending ids with your own revert) to end them one by one: it
  loses the revert and the hold that keep the screen consistent.

### Guessing data that depends on a selection

A guess on a value whose question reads a selection holds the selection with it: while the action runs, choosing
something else waits for the server, and the screen stays on the old choice until the action ends (F-1). Keep the
pending items in a source of their own, with a constant question, and show them beside the loaded ones:

```
source photo: number := 1
tags = await loadTags(photo)
source adding: { photo: number; tag: string }[] = []
shownAdding = adding.filter(a => a.photo == photo)   // shown after `tags`

export action addTag(p: number, tag: string) {
  try {
    optimistic adding := [...adding, { photo: p, tag: tag }]
    await saveTag(p, tag)
    refresh tags                              // the server's list now has the tag; the guess goes with the action
  } catch (e) { … }
}
```

Changing `photo` while a tag is saving shows the new photo's tags at once, and the pending tag only under its own
photo.

### Data the server owns: three layers

Every screen over server data is the same stack. Each layer is derived from the one below and has its own lifetime,
and the screen reads only the top:

1. **The server's truth.** A question: `server = await loadTodos()`. It changes only when it is asked again, so end
   every write with `refresh server`.
2. **What the client owns over it.** A source whose question is the layer below: `source todos = shape(server, …)`
   (ST-5a). The client writes it (an edit, a draft, a flag, a failure to show), and a new answer from below resets
   it. Anything that must outlive that reset (in the todos app, the failures awaiting a retry) is a plain source
   this layer is derived from.
3. **Guesses.** `optimistic` writes on layer 2, made by an action and gone when the action ends.

`examples/todos.rx` is the whole app:

```
server = await loadTodos()                                  // 1. what the server has: re-asked after every write
source failures: Failure[] := []                            // outlives a reset: kept until a retry is accepted
source todos: Row[] key id = withFailures(server, failures) // 2. the client's layer; 3. row guesses go on it
source adding: Row[] key id = []                            // 3. adds in flight (a new row has no index to guess)

export action add(id: string, title: string) {
  try {
    optimistic adding := as => [...as, { id: id, title: title, saving: true }]
    await addTodo(id, title)
    failures := fs => without(fs, id)
  } catch (e) {
    failures := fs => [...without(fs, id), { id: id, kind: "add", title: title }]
  }
  refresh server                                            // the accepted row comes from here
}
```

- **Never keep your own copy of what the server accepted.** Don't append the answer of a write to a list
  (`posted := [...posted, await addComment(…)]`): when a read and a write cross, the read's answer already has the
  new item and your copy adds it again. End the action with `refresh` on the server's list instead. The action's
  guesses stay up until that answer lands (D-35), so the row never blinks out and never shows twice.
- **A failure is the client's, not a guess.** A guess reverts when its action ends; a failure must outlast it, so it
  lives in the client's layer, and a successful retry removes it.
- **Generate ids on the client** in the handler, before calling the action, so a declined add can be shown again
  with its retry.

## 4. Things that look like bugs and aren't

- **A plain write in an action doesn't show until the server answers.** That's the hold. Use `optimistic` or
  `onFlush` (the table above). Don't move the code into a plain handler to escape it.
- **A declined row guess stays until another action's re-ask lands.** While an action's `refresh` of the list is
  in flight, the list's rows wait for that action (H-11), declined guesses included. That's by design; see "When
  a declined guess waits" above.
- **A click waits for an action it has nothing to do with.** A plain write to a source an action in flight has
  written or guessed joins that action's hold (H-2): a click that clears the action's error waits for the
  server. Keep such a write off the action's sources, or make it an `onFlush` run.
- **A failure stays up while its retry is in flight.** That's H-12. To show `loading…` instead, put
  `loading on(k)` above the `errored`.

## 5. Plain handlers

A handler that writes and awaits is an action (AC-1b), so it never lands a write early by accident. A write before
its `await` is a compile error (`HELD_WRITE`), because it would wait for the server: make it `optimistic` if it shows
while the work runs, `onFlush` if it is a reset, or declare the action if it should wait. Plain handlers are for
local state: typing, toggles, selection.

A run never sees its own writes: after `x := v`, reading `x` in the same run gives the old value (W-4), and the
compiler refuses it (`STALE_OWN_READ`). Keep the value in a local: `let n = count + 1; count := n; log(n)`.

## 6. Effects: acting on a value as it changes

`effect (a, b) { … }` runs its block with the inputs' values as `$0`, `$1`. Prefer an equation for anything that is
a value; an effect is for sending a value somewhere else (a parent's `on…` handler, `log`, a JS module).

- **When it runs**: once when its component appears, then after any change in which an input's value differs from
  the value the block last received (EF-2). The same value again is not a change. It runs after everything has
  settled, against what is on screen, and its writes are a new change of their own.
- **Loading inputs**: an input that is loading (a first load, or a re-ask after its inputs changed) is pending, and
  the block does not run until the answer lands (R-2). The effect doesn't hold the screen while it waits.
- **Failing inputs**: give an input that can fail a `catch` (`effect (x catch (e) => fallback) { … }`), so the block
  gets a plain value it can test for.
- **Guesses**: an input computed from an `optimistic` write fires as soon as the guess shows, and again with the old
  value if the guess reverts (EF-2). It doesn't wait for the action to end.
- **Lifetime**: an effect lives as long as its component. When the component goes away the effect stops, and its
  cleanup (a function the block returns) runs; nothing it would have seen later reaches it. State that must outlive
  a page belongs in a component that stays (pass it down, report changes up with an `on…` handler).
- **Order**: two effects that fire in the same change run in no promised order (EF-6).

## 7. Forms

A draft seeded once from loaded data is a source in the form's component, seeded with `peek`:
`source name := peek(props.initial.name)`. It belongs to the user from then on; a save never resets it.
