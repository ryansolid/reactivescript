# S-flush-1 — `onFlush`: a write that keeps out of another update's hold

Rules exercised: EF-8, W-3, H-2, AC-1; Solid `onFlush` (solidjs/solid#4292).

## Program

```rx
export default component App() {
  source open := true
  source page := 1
  details = await fetch("p" + str(page))

  <div>
    {if open { <p>menu:</p> } else { <p>closed:</p> }}
    {loading fallback { <p>loading</p> } { <p>{details catch (e) => "failed"}</p> }}
  </div>
}
```

A menu that closes when an item is picked, while the pick loads the next
page. The handler is the menu's `select`: it closes the menu and asks for a
new page in one run.

## Frames

| instant | action                                                    | frame      |
| ------- | --------------------------------------------------------- | ---------- |
| 0       | mount                                                     | `menu:loading` |
| 1       | resolve details "A"                                       | `menu:A`   |
| 2       | handler `onFlush(() => { open := false }); page := 2`     | `menu:A`   |
| 3       | (flush)                                                   | `closed:A` |
| 4       | resolve details "B"                                       | `closed:B` |

Instant 2: `page := 2` asks a new question; the disarmed boundary forwards
`details`'s reader into the hold (H-6), so the instant is held and the
screen keeps `menu:A`. Instant 3: the flush is done, and the `onFlush`
callback is a run of its own (EF-8), so `open := false` is a new instant.
Nothing it changes derives from the held work, so it commits at once: the
menu closes while the page is still loading. Instant 4: the hold commits.

## Variant: one run, one hold

| instant | action                                      | frame      |
| ------- | ------------------------------------------- | ---------- |
| 2       | handler `open := false; page := 2`          | `menu:A`   |
| 3       | resolve details "B"                         | `closed:B` |

Without `onFlush`, both writes are one instant (W-3) and the menu stays open
until the page lands.

## Rejected variants

```rx
-- reject: IO_IN_REACTIVE
export default component App() {
  source open := true
  closer = onFlush(() => { open := false })
  <p>{open}</p>
}
```

`onFlush` schedules a run; it is called from imperative scope (Solid warns
with `ON_FLUSH_IN_OWNED_SCOPE`; here it is a compile error).

```rx
-- reject: HOOK_CALLBACK
export default component App() {
  source open := true
  <button onClick={() => { onFlush(open) }}>x</button>
}
```

The argument is the run to schedule: a closure, `() => { … }`.
