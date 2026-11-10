# S-action-1 — try/catch in an action: the catch is still the action's change

Rules: AC-7, AC-1, AC-3, W-6, R-f-6.

## Program

```rx
export default component App() {
  source cart = [1, 2]
  source status := ""
  source orders := 0
  action placeOrder() {
    optimistic cart := []
    status := "placing"
    try {
      let receipt = await fetch("checkout")
      cart := []
      orders := orders + 1
      status := `ok ${receipt}`
    } catch (e) {
      status := `failed: ${e.message}`
    } finally {
      orders := n => n + 100
    }
  }

  <p>{cart.length} items / {status} / {orders}</p>
}
```

## Frames

| instant | action                      | frame                        |
| ------- | --------------------------- | ---------------------------- |
| 0       | mount                       | `2 items /  / 0`             |
| 1       | handler `placeOrder()`      | `0 items /  / 0`             |
| 2       | reject "checkout" "declined" | `2 items / failed: declined / 100` |

Instant 1: the guess shows now; `status := "placing"` is held with the
action. Instant 2: the rejection is thrown at the `await` and caught
*inside* the body — the catch's writes are the same change, the body then
ends normally (the finally ran too) and one frame commits: the guess
reverts to the truth, `status` and `orders` land. Nothing is reported as
a failed action: the action handled it.

## Variant: a panic ends the body — the held writes still commit

```rx
export default component App() {
  source cart = [1, 2]
  source status := ""
  action placeOrder() {
    optimistic cart := []
    status := "placing"
    try { let receipt = await fetch("checkout") } catch (e) { status := "declined" }
    fail("lost the receipt")
    cart := []
    status := "ok"
  }

  <p>{cart.length} items / {status}</p>
}
```

| instant | action                      | frame                  |
| ------- | --------------------------- | ---------------------- |
| 0       | mount                       | `2 items / `           |
| 1       | handler `placeOrder()`      | `0 items / `           |
| 2       | resolve "checkout" "r1"     | `2 items / placing`    |

AC-1 / DV-2: a body that ends by an exception ends like a return — the
held plain write `status := "placing"` commits, the guess reverts. Since
R-f-6 only a *panic* gets here: `fail(…)` is the prelude's JS function
that throws, and a JS throw is not in the failure row (R-f-3). A
rejection or a `throw` the body does not catch is a compile error (below).

## Variant: throw caught in a plain handler

```rx
export default component App() {
  source status := ""

  <p>{status}</p>
}
```

| instant | action | frame |
| ------- | ------ | ----- |
| 1       | handler `try { throw fail("boom") } catch (e) { status := e.message }` | `boom` |

## Rejected variants

```rx
-- reject: UNCAUGHT_ACTION_FAILURE
export default component App() {
  source cart = [1, 2]
  source status := ""
  action placeOrder() {
    optimistic cart := []
    status := "placing"
    let receipt = await fetch("checkout")
    cart := []
    status := "ok"
  }

  <p>{cart.length} items / {status}</p>
}
```

R-f-6: the rejection of `fetch("checkout")` (a JS promise: `fails(Error)`)
leaves the body uncaught, and nothing can catch it after — the handler
that launched the action does not await it.

```rx
-- reject: UNCAUGHT_ACTION_FAILURE
error Declined(reason)
export default component App() {
  source status := ""
  action placeOrder() {
    try { let r = await fetch("checkout") } catch (e) { throw Declined(e.message) }
    status := "ok"
  }

  <p>{status}</p>
}
```

A rethrow is a failure of the body like any other: the catch discharges
`Error` and its `throw` raises `Declined`, which nothing catches.

