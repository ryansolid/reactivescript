# S-solid-8 — an action holds its writes; display-ahead readers show them (Solid S-8; D-7, F-2, F-6, F-10)

Rules: AC-1, H-2, H-7, H-9, H-10.

## Program

```rx
export default component App() {
  source x := 0
  action save() { try { x := 1; await fetch("save") } catch {} }

  <div><p>{x}</p> <p>latest {latest x}</p> <p>{pending? x ? "saving" : "idle"}</p></div>
}
```

## Frames

| instant | action              | frame                 |
| ------- | ------------------- | --------------------- |
| 0       | mount               | `0 latest 0 idle`     |
| 1       | handler `save()`    | `0 latest 1 saving`   |
| 2       | resolve "save" 0    | `1 latest 1 idle`     |

Instant 1: the write is the action's change; the action holds it until its
body returns. The plain reader keeps `0`; the probes show ahead (H-7).
Instant 2: the body returns; nothing else holds the change; one frame.
Solid's row 1 ("before any flush") has no instant here: a write is visible
at its instant's settle (H-10) and the instant begins when the run ends.

## Variant: the body rejects — the held writes still commit

| instant | action                 | frame                 |
| ------- | ---------------------- | --------------------- |
| 2       | reject "save" "boom"   | `1 latest 1 idle`     |

AC-1: a rejection ends the body like a return — its held writes commit;
only optimistic state reverts (ruled 2026-10-22, DV-2; see S-solid-32's
rejected-save variant).
