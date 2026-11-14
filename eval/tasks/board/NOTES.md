# Board task: reviewer notes (never shown to agents)

Frozen 2026-11-14 (Ryan approved the draft as written).

Draft for Ryan's review. Not shown to any agent yet. Once it's frozen it becomes `eval/tasks/board/brief-plain.md`, and
the visible, hidden and overlap tests and the fuzz oracles are written against it. Notes for the reviewer are in
quote blocks like this one; they are not part of the brief.
**Why this task.** It shares no screens with the issue desk, so the guide can't have been tuned to it. It tests what
separated the arms on desk9, in new shapes:
- one item leaving one list and joining another while both lists can load or reload (the column move: two keyed lists
  and a guess in each);
- a count derived in two places from guesses (headings, the card's `done/total`, `progress`), which must agree;
- a limit derived from guesses (the WIP limit), so a stale count is visible as a wrong enabled button;
- a guess with no server id yet (the added card and item), which has to turn into the real one without a flicker or a
  duplicate;
- page lifetime (an answer to a page that was left must not show on the next visit; a write that lands after the
  page was left is not judged on that visit: Ryan 2026-11-14, late writes are a caching concern, out of scope).

**Hidden tests (sketch, about 60):** declines of every action; overlapping moves of one card (newest wins at rest);
moves while the target column is loading or retrying (the guess shows when it loads); a move whose column reloads
before its answer; an add accepted while To do reloads (no duplicate); toggles while the checklist reloads (kept);
archive of a selected card with a pending rename; the WIP limit with a move out of Doing still pending; answers that
land after the board page was left. **Fuzz:** a board-specific session generator over the same moves, plus oracles:
every card shows in exactly one column (no duplicates, none missing unless a write explains it); headings equal their
card counts; the card's `done/total` equals the checklist's `progress` when both show; at rest everything matches the
server, except fields a write from a left page landed on. Two accepted writes to one field must show the
server's last answer (Ryan 2026-11-14: the only correct answer).
