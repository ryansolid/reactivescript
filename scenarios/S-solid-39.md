# S-solid-39 — A later unread value still throws: one reader, either order (Solid S-39; D-25)

Rules: R-11, H-5, F-4; Solid D-25 (ruled 2026-10-09).

## Program

```
export default component App() {
  source s := 0
  source mounted := false
  n0 = await fetch("n:" + str(latest s))     // nobody on screen reads it yet
  action bump() { try { s := 1; await fetch("hold") } catch {} }
  <p>{mounted ? "on" : "off"}</p>{" "}
  {errored fallback(e) { <p>{e.message}</p> } { {if mounted { <p>{`[${latest s}, ${n0}]`}</p> }} }}
}
```

`[latest s, n0]` is one reader: `latest s` first. The variant below reads
`n0` first.

## Frames

| instant | action                    | frame        |
| ------- | ------------------------- | ------------ |
| 0       | mount                     | `off`        |
| 1       | handler `bump()`          | `off`        |
| 2       | handler `mounted := true` | `off`        |
| 3       | resolve "n:1" 1           | `on [1, 1]`  |
| 4       | resolve "hold" 0          | `on [1, 1]`  |

Instant 1: the action holds `s = 1`; `n0` follows `latest s`, so `n0(1)` is
asked. Instant 2: the new branch's reader reads `n0`, which has never shown
a value: the read throws, and a throw holds the pass — so the mount is held
(control stays `off`). `latest s` read first does not stop the throw;
publishing the branch with an empty slot is the violation (D-25).
Instant 3: `n0(1)` lands; control and `[1, 1]` reveal together.

## Variant: the other order

```
export default component App() {
  source s := 0
  source mounted := false
  n0 = await fetch("n:" + str(latest s))
  action bump() { try { s := 1; await fetch("hold") } catch {} }
  <p>{mounted ? "on" : "off"}</p>{" "}
  {errored fallback(e) { <p>{e.message}</p> } { {if mounted { <p>{`[${n0}, ${latest s}]`}</p> }} }}
}
```

| instant | action                    | frame        |
| ------- | ------------------------- | ------------ |
| 0       | mount                     | `off`        |
| 1       | handler `bump()`          | `off`        |
| 2       | handler `mounted := true` | `off`        |
| 3       | resolve "n:1" 1           | `on [1, 1]`  |

## Variant: inside a fresh `loading` the throw is caught (row 1′)

```
export default component App() {
  source s := 0
  source mounted := false
  n0 = await fetch("n:" + str(latest s))
  action bump() { try { s := 1; await fetch("hold") } catch {} }
  <p>{mounted ? "on" : "off"}</p>{" "}
  {errored fallback(e) { <p>{e.message}</p> } { {if mounted { {loading fallback { <p>loading</p> } { <p>{`[${latest s}, ${n0}]`}</p> }} }} }}
}
```

| instant | action                    | frame           |
| ------- | ------------------------- | --------------- |
| 0       | mount                     | `off`           |
| 1       | handler `bump()`          | `off`           |
| 2       | handler `mounted := true` | `on loading`    |
| 3       | resolve "n:1" 1           | `on [1, 1]`     |
