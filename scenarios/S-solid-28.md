# S-solid-28 — Imperative probes: `pending?` of a first load is false; `latest` of it throws (Solid S-28; D-23)

Rules: R-9, R-12, R-8; Solid D-23 (A16, A7).

## Program

```
export default component App() {
  source id := 1
  user = await fetch("u:" + str(id))
  source seen := ""
  <p>{seen}</p>{" "}
  {errored fallback(e) { <p>{e.message}</p> } {
    {loading fallback { <p>loading</p> } { <p>{user} {pending? user ? "p" : "-"}</p> }}
  }}
}
```

## Frames

| instant | action                                                                       | frame                 |
| ------- | ---------------------------------------------------------------------------- | --------------------- |
| 0       | mount                                                                        | `loading`             |
| 1       | handler `seen := pending? user ? "pending" : "not pending"`                  | `not pending loading` |
| 2       | handler `try { seen := latest user } catch (e) { seen := "not ready" }`      | `not ready loading`   |
| 3       | resolve "u:1" "Ann"                                                          | `not ready Ann -`     |
| 4       | handler `seen := latest user`                                                | `Ann Ann -`           |
| 5       | handler `id := 2`                                                            | `Ann Ann p`           |
| 6       | handler `seen := pending? user ? "pending" : "not pending"`                  | `pending Ann p`       |

Instant 1: a snapshot of the verdict (R-12) taken in a handler — no owner,
so nothing to hold — on a first load is `false`: there is no new question
yet, only no answer. In a view the same probe has no verdict until the
answer (R-9: the reader is held, here caught by `loading`). Instant 2:
`latest` of a value that has never had one throws, in a handler as
anywhere (Solid A7: resolved async never reads `undefined`). Instants 5–6:
a new question — `pending?` is a real verdict now, in both scopes.
