# S-region-4 — effect regions: first run, cleanup, disposal

Rules exercised: RG-3, EF-2, EF-4, EF-5, O-2.

## Program

```rx
export default component App() {
  source open := true
  source n := 0

  <div>
    {if open {
      effect (n) { log("run " + str(n)); fn () => log("cleanup " + str(n)) }
      <p>{n}</p>
    } else { <p>closed</p> }}
  </div>
}
```

The apply block's last expression is its result; a function result is the
cleanup (EF-5). `str` is the string builtin.

## Frames

| instant | action                  | frame    | effect                              |
| ------- | ----------------------- | -------- | ----------------------------------- |
| 0       | mount                   | `0`      | `log(run 0)`                        |
| 1       | handler `n := 1`        | `1`      | `log(cleanup 1); log(run 1)`        |
| 2       | handler `n := 1`        | `1`      | —                                   |
| 3       | handler `open := false` | `closed` | `log(cleanup 1)`                    |
| 4       | handler `open := true`  | `1`      | `log(run 1)`                        |

Instant 1: the cleanup runs before the next apply (EF-5), reading `n` as a
snapshot of the *committed* instant — so it logs 1, not 0. Instant 3: the
branch region ends and runs the effect's cleanup (O-2, RG-3). Instant 4: a
fresh effect in a fresh region runs its first apply (EF-2).
