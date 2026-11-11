# S-infer-6 — a write after an await is not built from a read before it

Rules: AC-1e, W-6, AC-1, H-2.

## Program

```rx
export default component App() {
  source log := ""
  action add(x: string) {
    let r = await fetch(x) catch (e) => ""
    log := v => v + x
  }

  <button onClick={() => { add("a") }}>log: {log}</button>
}
```

## Frames

| instant | action                | frame     |
| ------- | --------------------- | --------- |
| 0       | mount                 | `log: `   |
| 1       | handler `add("a")`    | `log: `   |
| 2       | handler `add("b")`    | `log: `   |
| 3       | resolve "b" "ok"      | `log: b`  |
| 4       | resolve "a" "ok"      | `log: ba` |

Two adds are out at once. Each appends to `log` as it stands at its write
(W-6), so the one that lands second keeps the first one's work.

## Rejected variants

```rx
-- reject: STALE_WRITE_BACK
export default component App() {
  source log := ""
  action add(x: string) {
    let before = log
    let r = await fetch(x) catch (e) => ""
    log := before + x
  }
  <button onClick={() => { add("a") }}>log: {log}</button>
}
```

`before` is `log` as it was when the add started. Written back after the
`await`, it erases whatever changed `log` in between: here the other add,
so the frames would end at `log: a`, not `log: ba`. The compiler sees the
read, the `await` and the write in one body, so this is an error; Solid
cannot see them and lets the lost update through.

```rx
-- reject: STALE_WRITE_BACK
export default component App() {
  source items := []
  action add(x: string) {
    let before = items
    guess items := [...before, x + "…"]
    let r = await fetch(x) catch (e) => ""
    items := [...before, x]
  }
  <button onClick={() => { add("a") }}>{len(items)}</button>
}
```

The guess before the `await` is fine: it is this change's own picture. The
write after it is the lost update (found by the eval's round 4: two posts
at once, and a list that reloaded while a post was out).

```rx
-- reject: STALE_WRITE_BACK
export default component App() {
  source detail := { id: 1, title: "a" }
  action rename(t: string) {
    let d = detail
    let r = await fetch(t) catch (e) => ""
    detail := { id: d.id, title: t }
  }
  <button onClick={() => { rename("b") }}>{detail.title}</button>
}
```

Through a field, too: `d.id` is `detail` as it was. If the user selected
another issue meanwhile, this writes the old issue over the new one.
