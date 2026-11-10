# S-solid-23 — a portal behind a fallback waits for the reveal

Rules exercised: RG-8 (PT-1, PT-2), H-5. Solid scenario mirrored: S-23 (D-19).

## Program

```rx
export default component App() {
  x = await fetch("data")

  errored fallback(e) { <p>error: {e.message}</p> } {
    loading fallback { <p>…</p> } {
      portal { <p>dialog for {x}</p> }
      <p>{x}</p>
    }
  }
}
```

The frame is the page's text, then ` » ` and what portals show at the end of
the document (RG-8). Behind the fallback the portal shows nothing: its
content is the region's, and the region has not revealed (D-19).

## Frames

| instant | action                | frame                     |
| ------- | --------------------- | ------------------------- |
| 0       | mount                 | `…`                       |
| 1       | resolve "data" "d"    | `d » dialog for d`        |

## Divergences

(none; Solid's ✗ row — the portal in `body` while the fallback shows — is
what D-19 ruled out)
