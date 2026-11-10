# S-region-5 — component application, props, children

Rules exercised: RG-4a, RG-4b, RG-4c, RG-1a, E-6.

## Program

```rx
component Greeting(props) {
  shout = props.name + "!"
  <p>{shout} {props.children}</p>
}
export default component App() {
  source name := "a"
  source show := true

  <div>
    {if show { <Greeting name={name}>{"hi"}</Greeting> }}
  </div>
}
```

## Frames

| instant | action                   | frame   |
| ------- | ------------------------ | ------- |
| 0       | mount                    | `a! hi` |
| 1       | handler `name := "b"`    | `b! hi` |
| 2       | handler `show := false`  | ``      |
| 3       | handler `show := true`   | `b! hi` |

Instant 1: `props.name` is an equation (RG-4b); the component is not
re-applied. Instant 2–3: the application lives in the branch region and is
recreated with it (RG-4a, RG-1a).

## Rejected variants

```rx
-- reject: RG-4a
component Greeting(props) { <p>{props.name}</p> }
export default component App() {
  x = Greeting

  <p>{x}</p>
}
```
