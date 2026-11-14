# desk9 reference: Foldkit 0.170.0

Grades 0: hidden 77/77, overlap 38/38, fuzz 0/20 (`--r9`; also 0/60 on seeds 21-80). 1847 lines.

- Labels and comments are Submodels (`Update.foldChild`); related hits open help through an OutMessage.
- Writes in flight are laid over the last server answer, newest started on top; label changes replay in start order.
- `learnFromEarlierVisit`: a write accepted after its page was left is applied to the reopened page (its pending
  display and errors are not). Without it the fuzz flags a row/detail disagreement or a stale comment list at rest,
  though the brief only says leaving a page discards it.
- Two accepted writes to one field: the last answered wins (as vanilla; React keeps newest started).
