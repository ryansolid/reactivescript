# S-region-2 — narrowed binding keeps updating

Rules exercised: RG-1b, RG-1c, E-11.

## Program

```rx
export default component App() {
  source user := { name: "a" }

  <div>
    {if user { <p>{user.name}</p> } else { <p>none</p> }}
  </div>
}
```

## Frames

| instant | action                              | frame  |
| ------- | ----------------------------------- | ------ |
| 0       | mount                               | `a`    |
| 1       | handler `user.name := "b"`          | `b`    |
| 2       | handler `user := { name: "c" }`     | `c`    |
| 3       | handler `user := undefined`         | `none` |
| 4       | handler `user := { name: "d" }`     | `d`    |

Instants 1–2: the branch is not recreated (truthy→truthy, RG-1b); `user`
inside it is the narrowed equation and tracks the path (RG-1c). Instant 1 is
a path write; instant 2 replaces the value (new identity) — both reach the
reader of `user.name` through the per-path dependency.
