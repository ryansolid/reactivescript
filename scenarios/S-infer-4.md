# S-infer-4 — `affects` makes a handler an action, so a refresh holds

Rules: AC-1b, AC-4, AC-5, D-31; the inline form of S-solid-26's `reload`.

## Program

```rx
export default component App() {
  user = await fetch("u")

  errored fallback(e) { <p>error: {e.message}</p> } {
    {loading fallback { <p>…</p> } {
      <button onClick={() => { try { affects user; refresh user; await fetch("gate") } catch (e) {} }}>{user.name} {pending? user ? "updating" : ""}</button>
    }}
  }
}
```

## Frames

| instant | action                                                                  | frame          |
| ------- | ----------------------------------------------------------------------- | -------------- |
| 0       | mount                                                                   | `…`            |
| 1       | resolve user { name: "Ann" }                                            | `Ann `         |
| 2       | handler `try { affects user; refresh user; await fetch("gate") } catch (e) {}` | `Ann updating` |
| 3       | resolve user { name: "Ann2" }                                           | `Ann updating` |
| 4       | resolve "gate" 0                                                        | `Ann2 `        |

Instant 2: `affects` declares the work: pending. Instant 3: the re-ask
lands into the action's change (D-31) and waits for it. Instant 4: the
body ends and both reveal. As a plain handler, the change would have ended
at the `await`, and `updating` would never have shown.
