# S-destructuring — a destructured name keeps updating; a destructured local is a snapshot

Rules: RG-4b, E-1, 07 §5, W-4.

## Program

```rx
component Card({ title, size = "m", owner: { name } }) {
  { a, b: bee } = props.pair
  [first, , third = "z"] = props.list
  <p>{title} {size} {name} {a} {bee} {first} {third}</p>
}

export default component App() {
  source pair := { a: 1, b: 2 }
  source list := ["x", "y"]
  { a } = pair
  [head] = list.map(s => s.toUpperCase())

  <Card title="T" owner={{ name: "Ann" }} pair={pair} list={list} />
  <p>{a} {head}</p>
}
```

Each name a reactive pattern binds is an equation, a projection of the
right side that keeps updating (RG-4b): `{ a } = pair` is `a = pair.a`,
and `component Card({ title })` is `title = props.title`. A default
applies when the field is `undefined`, as in JS. A right side that is not a
name (`list.map(…)`) is computed once and read per name. In a handler,
`let { … } = e` is JavaScript's: each name a snapshot (07 §5).

## Frames

| instant | action          | frame                        |
| ------- | --------------- | ---------------------------- |
| 0       | mount           | `T m Ann 1 2 x z1 X` |
| 1       | handler `let { a: q, b } = pair; let [x = 0] = [q + b]; pair := { a: x, b: q }` | `T m Ann 3 1 x z3 X` |
| 2       | handler `list := ["p", "q", "r"]` | `T m Ann 3 1 p r3 P` |

Instant 1: the handler's locals are the snapshot `q = 1, b = 2`, so the
write is `{ a: 3, b: 1 }`; every projection of `pair` updates. Instant 2:
the list's third item now exists, so the default gives way.

## Rejected variants

```rx
-- reject: PARSE
export default component App() {
  source pair := { a: 1, b: 2 }
  { a, ...rest } = pair
  <p>{a}</p>
}
```

A rest pattern is not supported yet (`omit` is not in the prelude).

```rx
-- reject: WRITE_TO_NON_SOURCE
export default component App() {
  source pair := { a: 1, b: 2 }
  { a } = pair
  <button onClick={() => { a := 5 }}>{a}</button>
}
```

A destructured name is an equation: write the source it projects.
