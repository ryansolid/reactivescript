# S-solid-34 — provenance: an older action's late answer never corrects a newer guess (Solid S-34; D-34)

Rules: AC-3, R-4, H-11.

## Program

```rx
export default component App() {
  source id := 0
  source cat = await fetch("cat:" + str(id))
  action pick(n, name) { try { id := n; optimistic cat := name; await fetch("w" + str(n)) } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{cat} / {latest cat} {pending? cat ? "p" : "-"}</p>
  }
}
```

## Frames

| instant | action                          | frame                   |
| ------- | ------------------------------- | ----------------------- |
| 0       | mount                           | ``                      |
| 1       | resolve cat "home"              | `home / home -`         |
| 2       | handler `pick(1, "news")`       | `news / news p`         |
| 3       | handler `pick(2, "finance")`    | `finance / finance p`   |
| 4       | resolve "cat:1" "news"          | `finance / finance p`   |
| 5       | resolve "cat:2" "finance"       | `finance / finance -`   |
| 6       | resolve "w1" 0                  | `finance / finance -`   |
| 7       | resolve "w2" 0                  | `finance / finance -`   |

Instant 3: the second write to `id` joins the first action's hold (D-8);
the newer guess is the display. Instant 4: an older question's answer —
superseded (R-4), moves nothing. Instant 5: a silent confirm — `pending?`
is `false` though the answer is held. Never `news` after 3.
