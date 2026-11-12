# S-surface-4 — `else if` in markup

Rules: 07 §5 (Control).

`else if c { … }` chains a markup conditional: it is `else { if c { … } }`, at
block level and braced inside an element.

## Program

```rx
export default component App() {
  source n := 3

  <main>
    <p>{if n > 2 { <b>many</b> } else if n > 0 { <i>some</i> } else { <u>none</u> }}</p>
    {if n > 2 { <span>3+</span> } else if n === 1 { <span>one</span> } else { <span>other</span> }}
    <button onClick={() => { n := n - 1 }}>-</button>
  </main>
}
```

## Frames

| instant | action                | frame          |
| ------- | --------------------- | -------------- |
| 0       | mount                 | `many3+-`      |
| 1       | handler `n := n - 1`  | `someother-`   |
| 2       | handler `n := n - 1`  | `someone-`     |
| 3       | handler `n := n - 1`  | `noneother-`   |
