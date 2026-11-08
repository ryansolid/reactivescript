# S-solid-26 — `pending?` is about a new question (Solid S-26; D-23)

Rules: R-9, H-9, AC-4, AC-5, AC-3.

## Program

```
export default component App() {
  source id := 1
  user = await fetch("u:" + id)
  action reload() { try { affects user; refresh user; await fetch("gate") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>…</p> } { <div><p>{user.name}</p> <p>{pending? user ? "updating" : ""}</p></div> }}
  }
}
```

## Frames

| instant | action                         | frame            |
| ------- | ------------------------------ | ---------------- |
| 0       | mount                          | `…`              |
| 1       | resolve user { name: "Ann" }   | `Ann `           |
| 2       | handler `id := 2`              | `Ann updating`   |
| 3       | resolve user { name: "Bob" }   | `Bob `           |
| 4       | handler `refresh user`         | `Bob `           |
| 5       | resolve user { name: "Bob2" }  | `Bob2 `          |
| 6       | handler `reload()`             | `Bob2 updating`  |
| 7       | resolve user { name: "Bob3" }  | `Bob2 updating`  |
| 8       | resolve "gate" 0               | `Bob3 `          |

Instant 0: the probe's own read suspends with the first load — no verdict,
nothing observable (D-23). Instant 2: an input changed — a new question.
Instant 4: a re-ask of the same question is quiet; the fresh value reveals
silently (5). Instant 6: `affects` declares a reload: pending. Instant 7:
the re-ask lands into the action's hold (D-31) and reveals at its commit.

## Variant: a guess over `user` is verdict-inert (row 7)

```
export default component App() {
  source id := 1
  user = await fetch("u:" + id)
  source shown = user.name
  action nick(n) { try { optimistic shown := n; await fetch("gate") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>…</p> } { <div><p>{shown}</p> <p>{pending? shown ? "updating" : ""}</p></div> }}
  }
}
```

| instant | action                         | frame            |
| ------- | ------------------------------ | ---------------- |
| 0       | mount                          | `…`              |
| 1       | resolve user { name: "Ann" }   | `Ann `           |
| 2       | handler `nick("Annie")`        | `Annie `         |
| 3       | resolve "gate" 0               | `Ann `           |

The guess shows; `pending? shown` stays `false`. The body's end corrects
it by the truth at hand (D-34).
