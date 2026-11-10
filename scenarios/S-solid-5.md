# S-solid-5 — Membership is the tick's: two mounts in one instant merge their holds (Solid S-5; D-4)

Rules: H-3, H-4, D-1; Solid D-4. Solid's two `createRoot` mounts are two
branches of one app here (an app is one root, MO-1c); what is tested is the
same — which hold a mount joins is decided by the instant it is made in.

## Program

```rx
export default component App() {
  source a := 0
  source b := 0
  source showA := false
  source showB := false
  sa = await fetch("A:" + str(a)) catch (e) => "?"
  sb = await fetch("B:" + str(b)) catch (e) => "?"
  <p>{sa}/{sb}</p>
  {if showA { ma = a; <p>pA {ma}</p> }}
  {if showB { mb = b; <p>pB {mb}</p> }}
}
```

## Frames

| instant | action                             | frame                |
| ------- | ---------------------------------- | -------------------- |
| 0       | mount                              | ``                   |
| 1       | resolve "A:0" "x"                  | ``                   |
| 2       | resolve "B:0" "y"                  | `x/y`                |
| 3       | handler `a := 1`                   | `x/y`                |
| 4       | handler `b := 1`                   | `x/y`                |
| 5       | handler `showA := true; showB := true` | `x/y`            |
| 6       | resolve "A:1" "x1"                 | `x/y`                |
| 7       | resolve "B:1" "y1"                 | `x1/y1pA 1pB 1`      |

Each branch declares an equation over a held source — Solid's
`createMemo(() => a())` in the mount. A memo created while a hold is live
that reads a held value is born held (D-1): its reader holds the change
that mounted it. (A reader of `a` itself, with no equation between, would
show the committed `0` — D-3.)

Instants 3–4: two independent holds — `a = 1` waits on `A:1`, `b = 1` on
`B:1`. Instant 5: one instant mounts both branches; each reads a held
value, so the instant joins both holds, and they merge (D-4): one change.
Instant 6: `A:1` lands, but the merged change still waits on `B:1`.
Instant 7: everything reveals together.

## Variant: two instants, two independent holds (rows 1′–3′)

| instant | action                  | frame           |
| ------- | ----------------------- | --------------- |
| 5       | handler `showA := true` | `x/y`           |
| 6       | handler `showB := true` | `x/y`           |
| 7       | resolve "A:1" "x1"      | `x1/ypA 1`      |
| 8       | resolve "B:1" "y1"      | `x1/y1pA 1pB 1` |

Each mount joins only the hold its own instant read: `A:1` reveals its
change alone.

## Variant: both branches under one `errored` boundary

```rx
export default component App() {
  source a := 0
  source b := 0
  source showA := false
  source showB := false
  sa = await fetch("A:" + str(a))
  sb = await fetch("B:" + str(b))
  errored fallback(e) { <p>{e.message}</p> } {
    <p>{sa}/{sb}</p>
    {if showA { ma = a; <p>pA {ma}</p> }}
    {if showB { mb = b; <p>pB {mb}</p> }}
  }
}
```

| instant | action                  | frame           |
| ------- | ----------------------- | --------------- |
| 0       | mount                   | ``              |
| 1       | resolve "A:0" "x"       | ``              |
| 2       | resolve "B:0" "y"       | `x/y`           |
| 3       | handler `a := 1`        | `x/y`           |
| 4       | handler `b := 1`        | `x/y`           |
| 5       | handler `showA := true` | `x/y`           |
| 6       | handler `showB := true` | `x/y`           |
| 7       | resolve "A:1" "x1"      | `x1/ypA 1`      |
| 8       | resolve "B:1" "y1"      | `x1/y1pA 1pB 1` |

A boundary is where failures and pending are caught; it is not a reader
of the values under it, so it entangles nothing (D-3: a render effect's
mere existence entangles nothing). Each mount still joins only its own
instant's hold.
