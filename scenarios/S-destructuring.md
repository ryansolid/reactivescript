# S-destructuring — a destructured name keeps updating; a destructured local is a snapshot

Rules: RG-4b, E-1, 07 §5, W-4.

## Program

```rx
component Card({ title, size = "m", owner: { name }, ...rest }) {
  { a, b: bee } = rest.pair
  [first, , third = "z", ...more] = rest.list
  <p>{title} {size} {name} {a} {bee} {first} {third} {more.length}</p>
}

export default component App() {
  source pair := { a: 1, b: 2 }
  source list := ["x", "y"]
  { a, ...others } = pair
  [head, ...tail] = list.map(s => s.toUpperCase())

  <Card title="T" owner={{ name: "Ann" }} pair={pair} list={list} />
  <p>{a} {others.b} {head} {tail.length}</p>
}
```

Each name a reactive pattern binds is an equation, a projection of the
right side that keeps updating (RG-4b): `{ a } = pair` is `a = pair.a`,
and `component Card({ title })` is `title = props.title`. A default
applies when the field is `undefined`, as in JS. A right side that is not a
name (`list.map(…)`) is computed once and read per name. An object rest is
the right side without the named fields, as Solid's `omit` (a live view:
`rest.pair` is `props.pair`); an array rest is the items after the named
ones. In a handler, `let { … } = e` is JavaScript's: each name a snapshot,
and a rest a copy (07 §5).

## Frames

| instant | action          | frame                        |
| ------- | --------------- | ---------------------------- |
| 0       | mount           | `T m Ann 1 2 x z 01 2 X 1` |
| 1       | handler `let { a: q, ...r } = pair; let [x = 0] = [q + r.b]; pair := { a: x, b: q }` | `T m Ann 3 1 x z 03 1 X 1` |
| 2       | handler `list := ["p", "q", "r", "s"]` | `T m Ann 3 1 p r 13 1 P 3` |

Instant 1: the handler's locals are the snapshot `q = 1, r = { b: 2 }`, so
the write is `{ a: 3, b: 1 }`; every projection of `pair` updates, through
the rests too. Instant 2: the list's third item now exists, so the default
gives way, and each rest takes the items after its pattern's.

## Rejected variants

```rx
-- reject: PARSE
export default component App() {
  source pair := { a: 1, b: 2 }
  { ...rest, a } = pair
  <p>{a}</p>
}
```

A rest element is last, as in JS.

```rx
-- reject: WRITE_TO_NON_SOURCE
export default component App() {
  source pair := { a: 1, b: 2 }
  { a } = pair
  <button onClick={() => { a := 5 }}>{a}</button>
}
```

A destructured name is an equation: write the source it projects.

```rx
-- reject: WRITE_TO_NON_SOURCE
export default component App() {
  source pair := { a: 1, b: 2 }
  { a, ...rest } = pair
  <button onClick={() => { rest.b := 5 }}>{a}</button>
}
```

A rest is an equation too: `pair.b := 5` writes the field it shows.
