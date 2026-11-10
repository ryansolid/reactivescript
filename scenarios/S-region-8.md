# S-region-8 — Portals: owned where they are written, shown at the end of the document

Rules exercised: RG-8 (PT-1–PT-3), RG-1a, RG-7b, O-4.

## Program

```rx
context tone: string = "plain"
source open := false
source n := 0
component Dialog(props) {
  t = use tone
  <div>{t} dialog {n}<button onClick={() => { open := false }}>close</button></div>
}
provide tone = "loud"

export default component App() {
  <p>count {n}</p>
  if open {
    portal { <Dialog /> }
  }
}
```

The portal is a region of the `if` branch: it opens with the branch and is
disposed with it (RG-1a). It is owned where it is written, so `use tone`
inside it finds the program's provision (RG-7b), and its handler writes a
source of the program like any handler beneath it (O-4). What it renders is
placed at the end of the document — the frame shows it after ` » `.

## Frames

| instant | action                 | frame                            |
| ------- | ---------------------- | -------------------------------- |
| 0       | mount                  | `count 0`                        |
| 1       | handler `open := true` | `count 0 » loud dialog 0close`   |
| 2       | handler `n := 1`       | `count 1 » loud dialog 1close`   |
| 3       | handler `open := false`| `count 1`                        |

Served, the page is `count 0`: the server renders nothing for a portal
(PT-3), and here nothing is open anyway.

## Rejected variants

```rx
-- reject: CONTENT_MODEL
export default component App() {
  portal { <tr><td>x</td></tr> }
  <p>x</p>
}
```

A portal's place is the end of the document, where a `<tr>` has no table
(SV-7d).
