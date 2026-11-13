# S-guess-equation — a guess over an equation, and over a prop through one (Solid `createOptimistic(fn)`)

Rules: AC-3, ST-5c, H-11, D-34, W-1, O-4, RG-4b.

## Program

```rx
component Title(props) {
  shown = props.title
  action rename(t: string) {
    guess shown := t
    try { let r = await fetch("rename") catch (e) => props.title; props.done(r) } catch {}
  }
  <h1>{shown}</h1>
  <button onClick={() => { rename("Bob") }}>rename</button>
}

export default component App() {
  source name := "Ann"
  upper = name.toUpperCase()
  action shout() { try { guess upper := "ANN!"; await fetch("shout") } catch {} }
  action setName(v: string) { name := v }

  <Title title={name} done={setName} />
  <p>{name} {upper}</p>
  <button onClick={() => { shout() }}>shout</button>
}
```

`shown` and `upper` are equations, never written: a guess is not a write of
the truth, so it may sit over one (AC-3, ST-5c). Each lowers to Solid's
`createOptimistic(fn)`, whose setter only guesses. A guess over a prop is a
guess over the child's own equation of it: it shows where the child reads
`shown`, and the parent's `name` does not move until the answer is written.

## Frames

| instant | action                         | frame                              |
| ------- | ------------------------------ | ---------------------------------- |
| 0       | mount                          | `AnnrenameAnn ANNshout`         |
| 1       | handler `rename("Bob")`        | `BobrenameAnn ANNshout`         |
| 2       | resolve "rename" "Bob"         | `BobrenameBob BOBshout`         |
| 3       | handler `shout()`              | `BobrenameBob ANN!shout`        |
| 4       | resolve "shout" 0              | `BobrenameBob BOBshout`         |

Instant 1: the guess shows in the child only; the parent's `name` and
`upper` are unchanged (H-11). Instant 2: the answer is written as the
truth through the action the parent passed (O-4), `shown` re-derives to the
same value, the guess confirms silently. Instant 3: a guess over an
equation of a source. Instant 4: the body ends with nothing answering
`upper`, so the guess gives way to the truth at hand (D-34).

## Variant: the rename fails

| instant | action                         | frame                              |
| ------- | ------------------------------ | ---------------------------------- |
| 2       | reject "rename" "boom"         | `AnnrenameAnn ANNshout`         |

The catch writes the prop's own value back; the guess reverts with the
body's end (AC-1, D-34).

## Rejected variants

```rx
-- reject: WRITE_TO_NON_SOURCE
export default component App() {
  source name := "Ann"
  upper = name.toUpperCase()
  <button onClick={() => { upper := "X" }}>{upper}</button>
}
```

A plain write to an equation stays an error (W-1): only the guess may sit
over one.

```rx
-- reject: WRITE_TO_NON_SOURCE
component Title(props) {
  action rename(t: string) { guess props.title := t; await fetch("x") catch (e) => null }
  <button onClick={() => { rename("Bob") }}>{props.title}</button>
}
export default component App() {
  <Title title="Ann" />
}
```

A guess on `props` itself stays an error (O-4): it would read as the
owner's value changing. Guess over the child's own equation of it.

```rx
-- reject: GUESS_ON_DEFERRED
export default component App() {
  source name := "Ann"
  deferred later = name
  action fix() { guess later := "Zed"; await fetch("x") catch (e) => null }
  <button onClick={() => { fix() }}>{later}</button>
}
```

A deferred equation's value is a lagging copy (V-16); a guess has nothing
to confirm it there.

```rx
-- reject: GUESS_WHILE_LOADING
export default component App() {
  source id := 1
  likes = await fetch("likes:" + id) catch (e) => 0
  action send() {
    try {
      guess likes := likes + 1
      await fetch("like:" + id)
      refresh likes
    } catch (e) {}
  }
  <button onClick={() => { id := id + 1 }}>next</button>
  <button onClick={() => { send() }}>{likes}</button>
}
```

A click can guess `likes` while it loads a new question about `id`, which
the click reads too (AC-3a): the guess sits on the old answer and the new
one replaces it. Put the button inside the `loading` region that shows
`likes`, or disable it on `pending? likes`.
