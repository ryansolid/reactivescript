# S-hold-2 — shared input, three panels; `on` releases one

Mirrors Solid `concepts/async-reactivity` (the dashboard). Rules: H-2, H-4,
H-5, H-6, H-7, R-4.

## Program

```rx
export default component App() {
  source period := "q1"
  summary = await fetch("s:" + period)
  trend   = await fetch("t:" + period)
  audit   = await fetch("a:" + period)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div>
      <p>{latest period}</p>
      {loading fallback { <p>skel</p> } {
        <div><p>{summary}</p> <p>{trend}</p> <p>{audit}</p></div>
      }}
    </div>
  }
}
```

## Frames

| instant | action                   | frame           |
| ------- | ------------------------ | --------------- |
| 0       | mount                    | `q1skel`       |
| 1       | resolve summary 1        | `q1skel`       |
| 2       | resolve trend 2          | `q1skel`       |
| 3       | resolve audit 3          | `q11 2 3`      |
| 4       | handler `period := "q2"` | `q21 2 3`      |
| 5       | resolve summary 10       | `q21 2 3`      |
| 6       | resolve audit 30         | `q21 2 3`      |
| 7       | resolve trend 20         | `q210 20 30`   |

The write to `period` is held until the slowest panel answers; the three
change together (H-2). `latest period` moves at once (H-7).

## Variant: the audit panel takes its own skeleton with `on`

```rx
export default component App() {
  source period := "q1"
  summary = await fetch("s:" + period)
  trend   = await fetch("t:" + period)
  audit   = await fetch("a:" + period)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div>
      <p>{latest period}</p>
      {loading fallback { <p>skel</p> } {
        <div><p>{summary}</p> <p>{trend}</p></div>
      }}
      {loading on(period) fallback { <p>askel</p> } { <p>{audit}</p> }}
    </div>
  }
}
```

| instant | action                   | frame               |
| ------- | ------------------------ | ------------------- |
| 0       | mount                    | `q1skelaskel`      |
| 1       | resolve summary 1        | `q1skelaskel`      |
| 2       | resolve trend 2          | `q11 2askel`       |
| 3       | resolve audit 3          | `q11 23`           |
| 4       | handler `period := "q2"` | `q21 23`           |
| 5       | resolve summary 10       | `q21 23`           |
| 6       | resolve trend 20         | `q210 20askel`     |
| 7       | resolve audit 30         | `q210 2030`        |

Instant 4: the `on` boundary re-arms and takes its panel out of the hold
(H-6), but the other two panels still hold the write, so the page waits.
Instant 6: the hold commits; the re-armed boundary shows its skeleton from
that swap because its own request has not landed (H-5: the fallback
belongs to the frame of the change that armed it).

## Variant: audit lands first — its skeleton is never seen

```rx
export default component App() {
  source period := "q1"
  summary = await fetch("s:" + period)
  trend   = await fetch("t:" + period)
  audit   = await fetch("a:" + period)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div>
      <p>{latest period}</p>
      {loading fallback { <p>skel</p> } {
        <div><p>{summary}</p> <p>{trend}</p></div>
      }}
      {loading on(period) fallback { <p>askel</p> } { <p>{audit}</p> }}
    </div>
  }
}
```

| instant | action                   | frame               |
| ------- | ------------------------ | ------------------- |
| 0       | mount                    | `q1skelaskel`     |
| 1       | resolve summary 1        | `q1skelaskel`     |
| 2       | resolve trend 2          | `q11 2askel`      |
| 3       | resolve audit 3          | `q11 23`           |
| 4       | handler `period := "q2"` | `q21 23`           |
| 5       | resolve audit 30         | `q21 23`           |
| 6       | resolve summary 10       | `q21 23`           |
| 7       | resolve trend 20         | `q210 2030`        |
