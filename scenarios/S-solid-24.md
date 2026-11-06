# S-solid-24 — an armed boundary lets a lane reveal immediately; a disarmed one forwards (Solid S-24; D-12, F-5, F-6)

## Program

```
export default component App() {
  source id := 0
  details = await fetch("d:" + latest id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><b>{latest id}</b> {loading fallback { <p>loading</p> } { <p>{details}</p> }}</div>
  }
}
```

## Frames

| instant | action              | frame          |
| ------- | ------------------- | -------------- |
| 0       | mount               | `0 loading`    |
| 1       | handler `id := 1`   | `1 loading`    |
| 2       | resolve details 1   | `1 1`          |

The first load is the boundary's; the flight does not hold the lane, so the
header reveals now.

## Variant: once the boundary has shown content, the lane holds on `details`

```
export default component App() {
  source id := 0
  details = await fetch("d:" + latest id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><b>{latest id}</b> {loading fallback { <p>loading</p> } { <p>{details}</p> }}</div>
  }
}
```

| instant | action              | frame          |
| ------- | ------------------- | -------------- |
| 0       | mount               | `0 loading`    |
| 1       | resolve details 0   | `0 0`          |
| 2       | handler `id := 1`   | `0 0`          |
| 3       | resolve details 1   | `1 1`          |

The disarmed boundary forwards, so `details`' pending holds the lane
exactly as with no boundary there: header `1` beside details `0` is the
rejected screen.

## Hydration window

- "Frames" instant 2: `1 loading` — SV-3b: hydrated while the server's answer for `d:0` was still out, the boundary keeps the server's state until that answer arrives; `id := 1` is not followed before then, so `d:1`'s landing shows nothing (Solid's position, DV-11)
