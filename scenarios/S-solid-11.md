# S-solid-11 — entanglement through a shared derivation (Solid S-11; D-9, A15)

## Program

```rx
export default component App() {
  source x := 0
  source y := 0
  a = await fetch("a:" + x)
  b = await fetch("b:" + y)
  sum = a + b

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>A {a}</p> <p>B {b}</p> <p>Sum {sum}</p></div>
  }
}
```

## Frames

| instant | action            | frame              |
| ------- | ----------------- | ------------------ |
| 0       | mount             | ``                 |
| 1       | resolve a 0       | ``                 |
| 2       | resolve b 0       | `A 0 B 0 Sum 0`    |
| 3       | handler `x := 1`  | `A 0 B 0 Sum 0`    |
| 4       | handler `y := 1`  | `A 0 B 0 Sum 0`    |
| 5       | resolve a 1       | `A 0 B 0 Sum 0`    |
| 6       | resolve b 1       | `A 1 B 1 Sum 2`    |

Two flights, one shared on-screen derivation: one unit.

## Variant: without `Sum` the two are independent

```rx
export default component App() {
  source x := 0
  source y := 0
  a = await fetch("a:" + x)
  b = await fetch("b:" + y)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><p>A {a}</p> <p>B {b}</p></div>
  }
}
```

| instant | action            | frame        |
| ------- | ----------------- | ------------ |
| 0       | mount             | ``           |
| 1       | resolve a 0       | ``           |
| 2       | resolve b 0       | `A 0 B 0`    |
| 3       | handler `x := 1`  | `A 0 B 0`    |
| 4       | handler `y := 1`  | `A 0 B 0`    |
| 5       | resolve a 1       | `A 1 B 0`    |
| 6       | resolve b 1       | `A 1 B 1`    |
