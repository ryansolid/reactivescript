# S-store-1 — path writes notify per key; a root write is compared per path

Rules: ST-1, ST-2, ST-2a, ST-2c, W-3.

## Program

```rx
export default component App() {
  source user := { name: "Ann", prefs: { theme: "light", size: 12 } }
  effect (user.prefs.theme) { log("theme", $0) }
  effect (user.name) { log("name", $0) }

  <p>{user.name} {user.prefs.theme} {user.prefs.size}</p>
}
```

## Frames

| instant | action                                                            | frame             | effect                             |
| ------- | ----------------------------------------------------------------- | ----------------- | ---------------------------------- |
| 0       | mount                                                             | `Ann light 12`    | log(theme, light); log(name, Ann)  |
| 1       | handler `user.prefs.theme := "dark"`                              | `Ann dark 12`     | log(theme, dark)                   |
| 2       | handler `user.prefs.size := 14; user.name := "Bo"`                | `Bo dark 14`      | log(name, Bo)                      |
| 3       | handler `user := { name: "Bo", prefs: { theme: "dark", size: 14 } }` | `Bo dark 14`   | —                                  |
| 4       | handler `user := { name: "Bo", prefs: { theme: "dim", size: 14 } }`  | `Bo dim 14`    | log(theme, dim)                    |

Instant 1: only `(user.prefs, theme)` readers run; the `name` effect is
quiet. Instant 2: two path writes, one change. Instant 3: a root write
equal by paths is a no-op (E-6). Instant 4: the root write changes one leaf;
only its readers run.
