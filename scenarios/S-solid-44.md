# S-solid-44 — an outside input change under a guess is held with the guess's hold (Solid S-44; D-34, F-1)

Rules: H-9, H-11, AC-3, AC-4, ST-5.

## Program

```
export default component App() {
  source sel := 3
  source comments = await fetch("c:" + sel)
  action post() { try { optimistic comments := 9; await fetch("post"); refresh comments } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><span>{sel} {comments}</span> <span>{latest comments}</span> <span>{str(pending? comments)}</span></div>
  }
}
```

## Frames

| instant | action                | frame          |
| ------- | --------------------- | -------------- |
| 0       | mount                 | ``             |
| 1       | resolve "c:3" 4       | `3 4 4 false`  |
| 2       | handler `post()`      | `3 9 9 false`  |
| 3       | handler `sel := 1`    | `3 9 9 true`   |
| 4       | resolve "c:1" 2       | `3 9 9 true`   |
| 5       | resolve "post" 0      | `3 9 9 true`   |
| 6       | resolve "c:1" 2       | `1 2 2 false`  |

Instant 2: the guess shows and is verdict-inert. Instant 3: a new question,
not the guess's source answering: a guess is an edit over the answers to the
question it was written over, so the change is held with the guess's hold
(Solid D-34) and `pending? comments` is `true`. Instant 4: issue 1's answer
lands; still held, and `latest comments` is the displayed guess (decision 3
of solidjs/solid#4695). Instant 5: the post's body settles; its `refresh`
re-asks issue 1, so nothing commits yet. Instant 6: one frame. Any `1 …`
frame before instant 6 is a tear.

## Divergences (DV-19, DV-22)

- oracle "Frames" instant 3: `3 9 9 false`
- oracle "Frames" instant 4: `3 9 2 true`
- oracle "Frames" instant 5: `3 9 2 true`

Solid's S-44 is ruled, not built (#4695): today `pending? comments` reads
`false` under the new question (DV-22), and `latest comments` answers the new
question's answer instead of the displayed guess (DV-19, #4689). The screen
is the ruled one on every runner.
