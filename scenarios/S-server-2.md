# S-server-2 — A click before the client has taken over is replayed after it

Rules exercised: SV-3e, SV-3d; AC-1.

## Program

```rx
export default component App() {
  source n := 0
  source note := ""
  action bump() { n := n + 1 }

  <p>{n} {note}</p>{" "}
  <button onClick={() => { bump() }}>+</button>
  <input value={note} onInput={(e) => { note := e.target.value }} />
}
```

## Frames

| instant | action              | frame   |
| ------- | ------------------- | ------- |
| 0       | mount               | `0 +`   |
| 1       | handler `bump()`    | `1 +`   |

## Before hydration

The page is served, the user acts on it before the client has taken over,
and then the client hydrates. Rows: `click "<selector>"` and `input
"<selector>" "<text>"` are the user, in the browser; `hydrate` is the
client taking the page over. A frame before `hydrate` is the served HTML,
which no handler is attached to yet.

| instant | action                      | frame     |
| ------- | --------------------------- | --------- |
| 0       | mount                       | `0 +`     |
| 1       | click "button"              | `0 +`     |
| 2       | click "button"              | `0 +`     |
| 3       | input "input" "hi"          | `0 +`     |
| 4       | hydrate                     | `2 hi +`  |
| 5       | click "button"              | `3 hi +`  |

Instants 1–3: nothing runs — the page is HTML — but each event is recorded
against the element it happened on (Solid's hydration bootstrap, installed
for `click` and `input`). Instant 4: the client takes over and replays
them in order, through the handlers it has just attached: two `bump()`s
and the input's text, **each its own instant** (SV-3e) — the program cannot
tell a replayed click from a live one, so the counter reads 2 as it would
have live. Instant 5: an ordinary client instant (SV-3d).
