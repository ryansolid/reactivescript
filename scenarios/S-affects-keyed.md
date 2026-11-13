# S-affects-keyed — `affects` on a keyed source that takes a guess

Rules exercised: AC-5, AC-3, AC-4, H-9.

## Program

```rx
export default component App() {
  source tick := 0
  day = await fetch("d" + str(tick))
  source rows key id = day.rows
  source err := "none"
  action move(id: number, at: number) {
    try {
      let i = rows.findIndex(r => r.id == id)
      guess rows[i].at := at
      affects rows
      await fetch("save")
      refresh day
    } catch (e) { err := e.message }
  }
  errored fallback(e) { <p>error</p> } {
    loading fallback { <p>loading</p> } {
      <p>{for r in rows { <i>{r.at}</i> }}{pending? rows ? "saving" : ""} {err}</p>
    }
  }
}
```

A keyed source over an answer, written by a guess, lowers to an optimistic store. The action declares its work on the
whole list with `affects rows`, so `pending? rows` is true until the action ends (AC-5), and the save is asked.

## Frames

| instant | action | frame |
| ------- | ------ | ----- |
| 0 | mount | `loading` |
| 1 | resolve "d0" {"rows":[{"id":1,"at":0},{"id":2,"at":3}]} | `03 none` |
| 2 | handler `move(1, 5)` | `53saving none` |
| 3 | resolve "save" 0 | `53saving none` |
| 4 | resolve "d0" {"rows":[{"id":1,"at":5},{"id":2,"at":3}]} | `53 none` |

Reported as solidjs/reactivescript#50: the compiled runtime handed `affects` the source's accessor, a wrapper around
the store, where `refresh` already unwrapped it. Solid's dev build threw `INVALID_AFFECTS_TARGET` into the action's
`catch`, so the save was never asked and the guess reverted (instant 2 read `03 none`, then the error); its
production build ignored the call, so `pending? rows` never turned true.
