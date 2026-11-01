# S-ai-feed — a chat feed: rooms fetched once, a message stream per room, an optimistic send, context for the selected room

Rules: R-1, R-4, R-7, ST-4, ST-5a, ST-6, AC-1, AC-3, AC-7, H-5, H-6, H-11, RG-7, W-6, EF-2.

Written from the spec alone (`spec/02`–`08`), program in `examples/ai/feed.rx`:
a room list under a `loading` boundary, the selected room's messages as a
stream with a first paint of `[]`, a compose box whose `send` is an action
with an optimistic append (and an optimistic clear of the draft and a
`sending` flag — three guesses over constant-question sources), a typing
indicator (`if draftText != ""`), and a room list that reads the selected
room through `(use room).current` and picks one by calling
`(use room).pick(id)`, a writer the module provides (O-4; until
2026-10-31 the context carried the source itself, RG-7c).

## Program

file: ../examples/ai/feed.rx

## Frames

| instant | action | frame | effect |
| ------- | ------ | ----- | ------ |
| 0 | mount | `rooms…send` | log(count, 0) |
| 1 | resolve "fetchRooms:" [{ id: 1, name: "general" }, { id: 2, name: "random" }] | `general * random - send` | — |
| 2 | resolve "streamMessages:1" [{ id: 1, from: "ann", text: "hello" }, { id: 2, from: "bob", text: "hey" }] | `general * random - ann: hello bob: hey send` | log(count, 2) |
| 3 | handler `draftText := "hi"` | `general * random - ann: hello bob: hey hityping…send` | — |
| 4 | handler `send()` | `general * random - ann: hello bob: hey me: hi sending…` | log(count, 3) |
| 5 | resolve "streamMessages:1" [{ id: 1, from: "ann", text: "hello" }, { id: 2, from: "bob", text: "hey" }, { id: 3, from: "me", text: "hi" }] | `general * random - ann: hello bob: hey me: hi sending…` | — |
| 6 | resolve "sendMessage:1,hi" { ok: true } | `general * random - ann: hello bob: hey me: hi send` | — |
| 7 | handler `selected := 2` | `general - random * loading…send` | — |
| 8 | resolve "streamMessages:2" [{ id: 10, from: "cat", text: "yo" }] | `general - random * cat: yo send` | log(count, 1) |
| 9 | resolve "streamMessages:1" [{ id: 1, from: "ann", text: "hello" }] | `general - random * cat: yo send` | — |

Instant 0: `rooms` is pending and caught by its armed boundary (H-5);
`messages` has a first paint (R-7) so nothing else is pending and the mount
commits. Instant 2: a stream landing is a quiet change of its own (ST-6a).
Instant 4: the three guesses show from the instant's settle (H-11) while the
action's change is held (AC-1); the effect over `len(msgs)` derives from the
guess and its apply runs *now*, with the guess's reveal, not at the commit
(found by `ref/` and confirmed by the oracle — the spec's H-2 places apply
blocks after the commit and says nothing about lanes). Instant 5: the server
echoes the message — an answer equal to the guess confirms silently and
nothing changes. Instant 6: the body returns, the hold commits as one frame:
`draftText := ""` lands, `sending` reverts to its truth; the count was
already 3, so the effect is quiet. In the variant, the revert runs it again
(`log(count, 2)`). Instant 7: `on(selected)` re-arms the boundary (H-6) and the new
question is caught by it (H-5); the room list's `use room` readers show
the move in the same frame. Instant 9: the old room's stream is an abandoned
flight — its late answer is inert (R-4).

## Variant: the send rejects — the guesses revert, the catch reports

| instant | action | frame | effect |
| ------- | ------ | ----- | ------ |
| 5 | reject "sendMessage:1,hi" "boom" | `general * random - ann: hello bob: hey hityping…sendboom` | log(count, 2) |

The appended message, the cleared draft and the `sending` flag were guesses
and revert (AC-1, DV-2); the draft's plain write `"hi"` still overrides its
question (ST-5a). `error := e.message` in the `catch` is still the action's
change and lands with the body's end (AC-7).

## Rejected variants

```
-- reject: OPTIMISTIC_NO_QUESTION
-- handler: pick()
export default component App() {
  source selected := 1
  action pick() { optimistic selected := 2; await fetch("x") }

  <p>{selected}</p>
}
```

`selected` is declared with `:=` — it has no question for a guess to confirm against (ST-5c).

```
-- reject: RG-7b
context room: number
component Room(props: { id: number }) {
  <p>{(use room) == props.id ? "*" : "-"}</p>
}

export default component App() {
  <Room id={1} />
}
```

No provision of `room` above the room.

## Hydration window

- "Frames" instant 8: `` — SV-3b: a stream the server is still sending when the client takes over stays the server's until it ends; the new room is not followed before then, so its stream is not asked (Solid's position, DV-11)
