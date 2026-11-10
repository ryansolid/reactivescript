# S-solid-35 — the body's end corrects a guess nothing authoritative is answering (Solid S-35; D-34)

Rules: AC-1, AC-3, H-11.

## Program

```rx
export default component App() {
  source truth := 1
  source guess = truth
  action attempt() { try { optimistic guess := 5; await fetch("unrelated") } catch {} }

  <p>{guess} / {latest guess} {pending? guess ? "p" : "-"}</p>
}
```

## Frames

| instant | action                   | frame       |
| ------- | ------------------------ | ----------- |
| 0       | mount                    | `1 / 1 -`   |
| 1       | handler `attempt()`          | `5 / 5 -`   |
| 2       | resolve "unrelated" 0    | `1 / 1 -`   |

Instant 1: the guess's own source is not re-asked: `pending? guess` is
`false`. Instant 2: the body returns with nothing authoritative in flight;
the guess is corrected by the truth at hand and, nothing else holding the
change, commits in the same instant. Solid's rows 2 and 3 (correction, then
commit) are one instant here.

## Variant: a derived flight keeps the hold open

```rx
export default component App() {
  source truth := 1
  source guess = truth
  derived = await fetch("x:" + str(guess))
  action attempt() { try { optimistic guess := 5; await fetch("unrelated") } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{guess} {derived} / {latest guess} {pending? guess ? "p" : "-"}</p>
  }
}
```

| instant | action                   | frame           |
| ------- | ------------------------ | --------------- |
| 0       | mount                    | ``              |
| 1       | resolve derived "x1"     | `1 x1 / 1 -`    |
| 2       | handler `attempt()`          | `1 x1 / 5 -`    |
| 3       | resolve "unrelated" 0    | `1 x1 / 1 -`    |
| 4       | resolve "x:5" "x5"       | `1 x1 / 1 -`    |
| 5       | resolve derived "x1"     | `1 x1 / 1 -`    |

Instant 2: the guess's lane holds itself on `derived(5)`; the guess never
shows in `{guess}`, but `{latest guess}` reads ahead of the held lane and
shows it (H-7, DV-10 — Solid's position, adopted 2026-10-26). Instant 3:
the body's end corrects the guess — `derived` re-asks from the truth
(`x:1`), so instant 5's `resolve derived` lands that flight while the
obsolete `x:5` (instant 4) is inert; `latest guess` is the truth from
instant 3, and untracked `pending? guess` is `true` until the commit.

## Variant: the guess's own question re-asked holds the change

```rx
export default component App() {
  source list = await fetch("list")
  action add() { try { optimistic list := list + "+mine"; await fetch("save"); refresh list } catch {} }

  errored fallback(e) { <p>error: {e.message}</p> } {
    <p>{list}</p>
  }
}
```

| instant | action                   | frame       |
| ------- | ------------------------ | ----------- |
| 0       | mount                    | ``          |
| 1       | resolve list "a"         | `a`         |
| 2       | handler `add()`          | `a+mine`    |
| 3       | resolve "save" 0         | `a+mine`    |
| 4       | resolve list "a,mine"    | `a,mine`    |

The other side of D-34, for a guess over a whole value (`createOptimistic`,
not a store): instant 3, `refresh list` re-asks the guess's own question,
so the body's end does not correct the guess; the change commits when the
new answer lands (instant 4). Lowered, `refresh` must re-ask the question
under the guess, not the guess's layer.
