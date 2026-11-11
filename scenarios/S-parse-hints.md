# S-parse-hints — JavaScript habits name their .rx form

Rules exercised: W-1, W-2, W-6, SC-3, 07. Each rejected variant is a line a JavaScript, React or Solid writer would
write; the parse error carries the code (guide/diagnostics.md) and the `.rx` it most likely meant.

## Program

```
export default component App() {
  source n := 0
  double = n * 2
  <button onClick={() => { n := n + 1 }}>{n} {double}</button>
}
```

## Frames

| instant | action              | frame |
| ------- | ------------------- | ----- |
| 0       | mount               | `0 0` |
| 1       | handler `n := 2`    | `2 4` |

## Rejected variants

```
-- reject: JS_LOCAL
export default component App() {
  const n = 1
  <p>{n}</p>
}
```

```
-- reject: JS_LOCAL
let n = 1
export default component App() {
  <p>{n}</p>
}
```

```
-- reject: JS_FUNCTION
function twice(x) { return x * 2 }
export default component App() {
  <p>{twice(1)}</p>
}
```

```
-- reject: JS_RETURN
export default component App() {
  source n := 1
  return <p>{n}</p>
}
```

```
-- reject: OPTIMISTIC
export default component App() {
  source liked = false
  <button onClick={() => { optimistic liked := true; liked := true }}>♥</button>
}
```

```
-- reject: JS_API
export default component App() {
  [n, setN] = createSignal(0)
  <p>{n}</p>
}
```

```
-- reject: ASSIGNMENT
export default component App() {
  source n := 0
  <button onClick={() => { n = n + 1 }}>{n}</button>
}
```

```
-- reject: ASSIGNMENT
export default component App() {
  source n := 0
  <button onClick={() => { n += 1 }}>{n}</button>
}
```

```
-- reject: ASSIGNMENT
export default component App() {
  source n := 0
  <button onClick={() => { n++ }}>{n}</button>
}
```

```
-- reject: REACTIVE_WRITE_IN_OWNED_SCOPE
export default component App() {
  source n := 0
  <button onClick={() => n := n + 1}>{n}</button>
}
```
