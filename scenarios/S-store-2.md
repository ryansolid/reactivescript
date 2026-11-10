# S-store-2 — a draft is a delta over `pre`; untouched paths keep identity

Rules: ST-3, C-2, E-6, EF-3.

## Program

```rx
export default component App() {
  source id := 1
  selected = draft(pre selected -> {}) { d[str(pre id -> 0)] := false; d[str(id)] := true }
  effect (selected["1"]) { log("one", $0) }
  effect (selected["2"]) { log("two", $0) }

  <p>{selected["1"] ? "1" : "-"} {selected["2"] ? "2" : "-"}</p>
}
```

## Frames

| instant | action             | frame   | effect                              |
| ------- | ------------------ | ------- | ----------------------------------- |
| 0       | mount              | `1 -`   | log(one, true); log(two, undefined) |
| 1       | handler `id := 2`  | `- 2`   | log(one, false); log(two, true)     |
| 2       | handler `id := 2`  | `- 2`   | —                                   |
| 3       | handler `id := 3`  | `- -`   | log(two, false)                     |

The draft starts from the previous value and writes two keys; the
equation's value is the draft. Instant 3 touches `"2"` and `"3"` only:
`selected["1"]` is unchanged and its effect is quiet.

## Rejected variants

```rx
-- reject: ST-3a
export default component App() {
  source id := 1
  source other := {}
  selected = draft(pre selected -> {}) { other[str(id)] := true }

  <p>{selected}</p>
}
```

A draft block writes only its draft.
