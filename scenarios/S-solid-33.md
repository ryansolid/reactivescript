# S-solid-33 — a different truth corrects the graph now and the screen at the commit; a never-shown guess is void (Solid S-33; D-34)

Rules: AC-3, H-7, H-11.

## Program

```rx
export default component App() {
  source value := 0
  source double = await fetch("d:" + str(value))
  related = await fetch("r:" + str(double))
  action bump() { value := 1; guess double := 3 }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>loading</p> } { <p>double={double} async={related}</p> }}
  }
}
```

## Frames

| instant | action                 | frame                        |
| ------- | ---------------------- | ---------------------------- |
| 0       | mount                  | `loading`                    |
| 1       | resolve double 0       | `loading`                    |
| 2       | resolve related 0      | `double=0 async=0 |
| 3       | handler `bump()`       | `double=0 async=0`     |
| 4       | resolve double 2       | `double=0 async=0`     |
| 5       | resolve "r:3" 9        | `double=0 async=0`     |
| 6       | resolve related 2      | `double=2 async=2`     |

Instant 3: the guess is in the graph (`related` re-asks from `3`); its
reader is in `double`'s lane, which holds itself on `related(3)` — so the
guess never shows. Instant 4: the truth `2 ≠ 3` corrects the graph now
(`related` re-asks from `2`), `latest double` answers the truth, the
screen keeps what it showed. Instant 5: the obsolete `related(3)` is inert.
Instant 6: one frame. Never a frame showing `double=3`.

Solid's probe columns (`latest(double)` 3 then 2, `isPending(double)` true
until the commit) are untracked reads; a `latest double` reader on screen
here is in `double`'s lane and keeps what it showed with the lane (D-25,
S-solid-24). The correction is visible through the flights: after instant
4 `related`'s flight is `r:2`, so `resolve related` lands it, and the
obsolete `r:3` is inert.
