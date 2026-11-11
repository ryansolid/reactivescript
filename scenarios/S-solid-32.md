# S-solid-32 — an optimistic write shows from its instant; held writes beside it; one frame at the end (Solid S-32; D-33)

Rules: AC-1, AC-3, ST-5, H-11.

## Program

```rx
export default component App() {
  source name := "Ann"
  source shown = name
  source saved := false
  action rename(n) { try { guess shown := n; saved := true; await fetch("save"); name := n } catch {} }

  <p>{shown} / {saved ? "saved" : "unsaved"} / {pending? shown ? "p" : "-"} {pending? saved ? "p" : "-"}</p>
}
```

## Frames

| instant | action                   | frame                  |
| ------- | ------------------------ | ---------------------- |
| 0       | mount                    | `Ann / unsaved / - -`  |
| 1       | handler `rename("Bob")`  | `Bob / unsaved / - p`  |
| 2       | resolve "save" 0         | `Bob / saved / - -`    |

Instant 1: the guess shows; `saved = true` is held; `pending? shown` is
`false` (verdict-inert), `pending? saved` is `true`. Instant 2: `name := n`
after the `await` is the action's; `shown` re-derives to the guess — a
silent confirm; the body returns; the guess ends and the held write commits
in one frame. Never `Ann / unsaved` after 1 (guess held) nor `Bob / saved`
(held write leaked).

## Variant: the save rejects — the guess reverts, the held write commits

| instant | action                   | frame                  |
| ------- | ------------------------ | ---------------------- |
| 2       | reject "save" "boom"     | `Ann / saved / - -`    |

The guess `Bob` reverts to the truth (`name` is still `Ann`); `saved = true`
was a plain write and commits (AC-1, DV-2).

## Variant: a guess in a handler, with nothing to hold it

| instant | action                              | frame                  |
| ------- | ----------------------------------- | ---------------------- |
| 1       | handler `guess shown := "Zed"` | `Ann / unsaved / - -`  |

A guess outside a hold does not exist (D-33). A handler with a guess is an
action (AC-1b), so this compiles; the action's change opens and commits in
the same instant, and the guess ends with it before any frame shows it.
The `effect` form, which is never an action, is still rejected (S-check-1).

## Rejected variants


```rx
-- reject: GUESS_NO_QUESTION
-- handler: fix()
export default component App() {
  source shown := "Ann"
  action fix() { try { guess shown := "Zed"; await fetch("x") } catch {} }

  <p>{shown}</p>
}
```
