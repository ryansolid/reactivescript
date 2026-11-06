# Repros for Solid 2.0 (`next`)

Standalone scripts against Solid's `next` branch built from source at the
commit in `ref/SOLID_NEXT` (every one re-run there, `0847122`, 2026-10-26) —
no ReactiveScript code involved. Run from `ref/oracle/` after `npm install`:

```
node --conditions=browser --conditions=development repros/dv3-signals.mjs [effect-in-fallback|read-in-fallback]
node --conditions=browser --conditions=development repros/dv3-web.mjs [element-fallback|array-fallback|static-fallback]
node --conditions=browser --conditions=development repros/dv4-signals.mjs [store|memo] [boundary|none]
node --conditions=browser --conditions=development repros/dv10-lane-effects.mjs [one|two]
node repros/dv9-ssr-after-shell.mjs [client|server-component] [ms]      # the server build: no --conditions
node repros/dv9-hydrate/run.mjs                                           # server + Chromium (playwright, esbuild)
node repros/dv11-hydrate/run.mjs
node repros/dv12-hydrate/run.mjs
node --conditions=browser repros/dv13-universal-empty.mjs
node repros/dv14-replay-instant/run.mjs
node --conditions=browser --conditions=development repros/dv16-latest-first.mjs [latest-first|n0-first]
node --conditions=browser --conditions=development repros/dv17-boundary-merges-mounts.mjs [boundary|none]
node --conditions=browser --conditions=development repros/dv18-projection-relanding.mjs [row-memo|direct]
node --conditions=browser --conditions=development repros/dv19-latest-reask.mjs
node --conditions=browser --conditions=development repros/4690-guess-reask-refresh.mjs
```

The hydration repros are each one `app.jsx`, compiled by Solid's own
compiler (`@solidjs/compiler`, `generate: "ssr"` and `"dom"`, hydratable),
streamed by the server build to Chromium and hydrated there by the DOM build
— beside a control that renders the same app on an empty page
(`_hydrate.mjs`).

---

## DV-3 — a render effect inside a re-armed boundary's fallback holds the content's reveal (fixed on `next` by solidjs/solid#4282; filed as #4268)

**Rule.** SCENARIOS.md S-22 row 3′ (D-18): *"if `content(2)` lands before
`meta(2)` → `content(2)` — the fallback is never seen."* Pinned by
`tests/loading-on-rearm-reveal-3540.test.ts` "content lands before the
fallback: the fallback is never seen".

**Shape.** An outer `Loading`, inside it a `Loading` with `on: id` whose
fallback reads async `meta` and whose content reads async `content`; both
memos depend on `id`. After the first load, `setId(2)`; `content(2)` lands
before `meta(2)`.

**Observed.** If the fallback *creates a render effect* that reads `meta` —
which is what any compiled JSX fallback does: `<p>Meta {meta()}</p>` is an
element plus an `insert` effect — the screen keeps `content(1)` after
`content(2)` lands, and reveals `content(2)` only when `meta(2)` lands:

```
                     effect-in-fallback    read-in-fallback (the pinned shape)
setId(2)             "content c1"          "content c1"
content(2) lands     "content c1"   ✗      "content c2"   ✓
meta(2) lands        "content c2"          "content c2"
```

`dv3-web.mjs` shows the same through `solid-js`'s `<Loading>` and
`@solidjs/universal`: an element fallback fails, an array fallback
(`["Meta ", () => meta()]`) and a static fallback pass.

**Likely cause.** The fallback's render effect is a frame reader that is
pending on `meta(2)` and counts toward the change's hold, though the
fallback is never the display in this race (H-4: a reader behind content
that is not shown holds nothing). The pinned test reads `fallbackData()`
directly in the fallback function, so no render effect exists and the
case is not covered.

---

## DV-4 — a derived store's per-key `isPending` is false under a boundary that has shown content (fixed on `next` by solidjs/solid#4278; filed as #4269)

**Rule.** RULES-DERIVED D-30: *"a derived store's leaves report the
derive's new-question refetch like any async memo"*; SCENARIOS S-37 row 2:
after `setId(2)`, `isPending(() => state.a)` is `true`.

**Shape.** `createStore(async draft => { Object.assign(draft, await fetch(id())) }, {})`,
a render effect showing `state.a` and `isPending(() => state.a)`, under a
`createLoadingBoundary` that has shown content. `setId(2)`.

**Observed.**

```
                      store, boundary   memo, boundary   store, no boundary
setId(2)              "1 -"   ✗         "1 pending"  ✓   "1 pending"  ✓
```

The async memo under the same boundary reports pending; the same store
outside a boundary reports pending. Only the store-under-boundary
combination reads `false`.

---

## DV-7 — an outer error boundary that caught a rethrow from an inner fallback does not recover (fixed on `next` by solidjs/solid#4277; filed as #4270)

Found while lowering typed `errored` boundaries (R-f-4); it is not one of
our divergences, because the lowering avoids the shape.

**Shape.** `createErrorBoundary(inner, …)` inside `createErrorBoundary(…)`;
the inner fallback rethrows an error it does not handle
(`err => { if (!(err() instanceof NotFound)) throw err(); … }`).

**Observed** (`dv7-rethrow.mjs`):

```
which   1 (NotFound)   0      2 (Other)      0               1            0
screen  inner:nf       ok0    outer:other    outer:other ✗   inner:nf     ok0
```

After the outer boundary takes the rethrown `Other`, the content recovering
(`which = 0`) does not clear it; only a later error in the inner boundary
re-renders through it. Expected `ok0` at the ✗.

**Likely cause.** The outer boundary's error belongs to the inner
fallback's computation; when the inner switches back to its content that
computation is disposed, and the outer is not told the error's source is
gone.

**How we lower around it.** The inner fallback returns a marker carrying
the error instead of throwing; a memo around the inner boundary reads it
and throws. That memo is an ordinary dependent of the boundary, so it
re-runs and recovers when the content does (S-fail-1 instants 6–8).

---

## DV-8 — a keyed projection over a memo stops following it after its first value (fixed on `next` by solidjs/solid#4280; filed as #4271 — the two cases left in S-ai2-search were our lowering, `dv8b-projection-pending.mjs`)

Found by an agent-written app (S-ai2-search): `results key id = q.length < 2
? throw TooShort(q) : await search(q)`, lowered as
`createProjection(() => src(), [], { key: "id" })` over the equation's memo.

**Observed** (`dv8-projection.mjs`):

```
q            a (throws)        c (value)   b (pending)   b lands   a (throws again)
screen       error:too short   1 -         1 -  ✗        2 -       2 -  ✗
```

The first failure reaches the boundary. Once the projection has held a
value, the memo's later pending state is not reported through it
(`isPending(() => proj.length)` stays false; compare DV-4, the same symptom
for a derived store), and a later failure is swallowed — the projection keeps
its last value and the boundary never sees the error. Expected: `1 pending`
and `error:too short`.

The same app without `key` (a plain memo) matches the spec frame for frame
in Solid; with `key`, the interpreter does too.

---

## DV-9 — a failed boundary renders no fallback on the server (a Solid bug, ruled 2026-10-26; solidjs/solid#4287, fixed on `next`)

**Rule.** 10-server SV-6: a boundary that takes a failure during the server
render is streamed with its fallback drawn, so the browser shows the
client's frame.

**Shape.** `<Errored fallback={e => <p>failed: {e().message}</p>}>` around a
`<Loading>` whose content reads an async memo; the memo rejects with an
error marked safe (`markSafeError`), either before the shell flushes
(`ms` = 1) or after (`ms` = 200, the default).

**Observed.**

```
                     client component                     runInServerComponentScope
fails after shell    <template id="100"> </template>      <template id="100"><p>failed: no user 7</p></template>
fails before shell   <main></main>                        <main><p>failed: no user 7</p></main>
```

Outside server-component scope the boundary's HTML is empty and the error
is serialized for the client, which draws the fallback when it hydrates;
until then the browser shows neither the loading fallback nor the error
fallback. `errorOutcome` in `ssrLoadingBoundary` and `renderOutcome` in the
server `createErrorBoundary` both return early unless
`inServerComponentScope`.

**After hydration** (`dv9-hydrate/`). The client renders the failed
boundary from scratch: it asks the question again and shows the loading
fallback, never the failure the server sent.

```
shell                      "loading"
the read fails (streamed)  ""
hydrated                   "loading"
```

---

## DV-10 — a held lane holds per render effect (reversed 2026-10-26: Solid's position adopted; solidjs/solid#4284, closed; the `one` mode is fixed on `next` at `2c9fdd9`)

**Rule.** 05 H-7 (since 2026-10-26, Solid's position): a tracked `latest x`
of an optimistic guess reads ahead of the guess's held lane; the lane's
other readers keep what they showed. Solid pins it in
`verdict-contract.test.ts` ("the reader breaks out of the lane").

**Shape.** `guess` is a question source with an optimistic layer;
`derived` awaits on `guess`. An action guesses `5` and awaits something
unrelated; `derived(5)` is pending, so the guess's lane is held.

**Observed.** With `latest(guess)` in its own effect — which is what
compiled JSX gives `<p>{guess()} {derived()} / {latest(guess)}</p>` — the
probe shows the guess: `"1 x1 / 5"`, as ruled. One render effect reading
`guess`, `derived` and `latest(guess)` keeps `"1 x1 / 1"`: that grouping is
the open bug. No scenario shows it.

---

## DV-11 — the hydration window (solidjs/solid#4272, closed by design; adopted as 10 SV-3b)

**Rule** (since 2026-10-26, Solid's position). 10 SV-3b: a node whose server
answer is still out when the client takes over keeps the server's state and
does not follow its inputs until that answer lands; the repro below shows
exactly that, and is kept as the window's demonstration.

**Shape.** `<Loading><p>{details()}</p></Loading>`, `details` over
`id`. The server's answer for `id = 0` has not arrived when the client
hydrates. Then `setId(1)`; the client asks `d:1`, and it lands.

**Observed.** Hydrated, the boundary stays on `"loading"`; rendered on an
empty page, it shows `"1"`. A stream is the same: the hydrated node reads
the server's async iterable until it ends, and the new question is not
asked (`hydrateSignalFromAsyncIterable`).

---

## DV-12 — a boundary hydrated in its error state never recovers (fixed on `next` by solidjs/solid#4279; filed as #4273)

**Rule.** 05 D-39, 10 SV-6: a boundary recovers when the failed content's
inputs change and a good answer lands.

**Shape.** `<Errored><p>{shown()}</p></Errored>`; `shown` throws when
`item` is `null`; the server's answer is `null`, so the server draws the
fallback. The client hydrates; `setSel(3)`; `i:3` is asked and lands
`"pear"`.

**Observed.** Hydrated: `"item 4 not found"` stays. Rendered on an empty
page: `"pear"`. `hydratedCreateErrorBoundary` throws the serialized error
on its first run instead of running the content, so the boundary tracks
nothing.

---

## DV-13 — an empty fragment loses its slot in the universal renderer (fixed on `next` by solidjs/solid#4276; filed as #4274)

**Shape.** `<main><A />{String(" ")}<B /></main>` compiled by
`@solidjs/compiler` with `generate: "universal"`; A is a `<Show>` that starts
on its fallback and then shows `<section><p>results</p></section>`.

**Observed.**

```
no fallback        " pick" → "results pick"
fallback={<></>}   " pick" → " pickresults"     ✗
fallback={<i />}   " pick" → "results pick"
```

Every child of `<main>` is dynamic, so each `insert` gets a `null` marker
and keeps its place with a sentinel. An empty array value
(`insertExpression` → `cleanChildren`) removes the sentinel and leaves the
region `[]`; the next non-empty value is appended (`appendNodes(parent,
value, null)`), after B.

---

## DV-14 — events replayed after hydration share one instant (a Solid bug, ruled 2026-10-26; solidjs/solid#4285, fixed on `next` by #4299)

**Rule.** 10 SV-3e: a replayed event is its own instant, as it would have
been live.

**Shape.** A served counter: `<p>{n()}</p><button onClick={() => bump()}>`,
`bump` an action writing `setN(n() + 1)`. Two clicks before the client
loads, then hydration; the control renders the page and clicks twice.

**Observed.**

```
clicked twice, then hydrated   before "0" · after "1"   ✗ (expected 2)
rendered, then clicked twice   before "2" · after "2"
```

`runHydrationEvents` drains `_$HY.events` in one microtask; no flush runs
between two replayed handlers, so both actions read the committed `n`.


---

## DV-15 — a client question's served fallback is rebuilt on hydration (a Solid bug, ruled 2026-10-26; solidjs/solid#4286, fixed on `next`)

**Rule.** 10 SV-3a: hydration adopts what the server sent; SV-7b: a client
question's reader shows its hold's fallback on the server, and the browser
asks the question once it has taken the page over.

**Shape.** `createMemo(() => ask("viewport"), { ssrSource: "client" })`
read under `<Loading fallback={<p>measuring</p>}>`. The server sends the
fallback and serializes the boundary as `"$$f"`; the browser hydrates.

**Observed.**

```
served "measuring" · hydrated "measuring" · dropped [<p _hk="20">measuring</p>] · built [<p>measuring</p>] · asked: viewport
```

The frame is right and nothing is asked twice, but the served `<p>` is
replaced by one the client builds: on the `"$$f"` route the boundary
hydrates the fallback, then resumes its content, which suspends on the
question it now asks, and the boundary renders its fallback again.
Expected: the hydrated fallback stays until the content can show.

---

## SV-7d — why a `<tr>` from another template goes in a `<tbody>` (not a divergence)

**Shape.** `<table><For each={names()}>{n => <Row name={n} />}</For></table>`
with `Row` returning `<tr><td>…</td></tr>`; hydrate, then add a row. The
control renders the same app on an empty page (`sv7d-table/`).

**Observed.**

```
hydrate  <table><tbody><tr><td>Ann</td></tr><tr><td>Bo</td></tr></tbody><tr><td>Cy</td></tr></table>
render   <table><tr><td>Ann</td></tr><tr><td>Bo</td></tr><tr><td>Cy</td></tr></table>
```

The parser put the served rows in a `<tbody>`; the client inserts its rows
into the `<table>`. Hydration claims by key and does not notice; the page is
two trees at once. This is HTML, not Solid: the checker refuses the
application (`CONTENT_MODEL`, S-server-4), and `examples/users.rx` now
writes its `<tbody>`.

---

## DV-16 — a reader whose first read is `latest(s)` publishes an empty slot (fixed on `next` by solidjs/solid#4281; filed as #4275)

**Rule.** SCENARIOS.md S-39 (D-28, ruled 2026-10-09): *"a later unread value
still throws"* — a reader that reads `latest(s)` and then `n0()`, a lane
derivation that has never shown a value, holds the mount like the
`n0()`-first order does. Publishing the branch with the slot empty is the ✗
row.

**Observed.** `dv16-latest-first.mjs latest-first`: after `setMounted(true)`
the control shows `on` and the slot is empty; `n0-first` holds (`off`) as
ruled. Both reveal `on [1, 1]` when `n0(1)` lands. Found by S-solid-39; the
spec (05, and the interpreter) holds in both orders.

---

## DV-17 — two mounts under one error boundary merge their holds (a Solid bug, ruled 2026-10-26; solidjs/solid#4283, fixed on `next` by #4302)

**Rule.** SCENARIOS.md S-5 rows 1′–3′ (D-4, *membership is the tick's*):
two mounts made in separate flushes, each over its own hold, settle
independently.

**Observed.** `dv17-boundary-merges-mounts.mjs boundary`: with both
`<Show>`s under one `<Errored>`, `slowA`'s landing reveals nothing until
`slowB` lands; `none` reveals `pA` alone, as ruled. The rules do not say a
boundary is a shared reader; ruled a Solid bug 2026-10-26. Found by
S-solid-5.

---

## DV-18 — a keyed projection's row readers miss every landing after the first (a regression from solidjs/solid#4280) — filed as solidjs/solid#4305, fixed on `next`

**Rule.** RULES-DERIVED D-30, spec ST-4 and H-2: each landing reconciles a
keyed projection's rows, and its readers show it.

**Shape.** `createProjection(() => src(), [], { key: "id" })` over an async
memo; `mapArray` over the rows with a memo per row reading `row.name`
(what a `<For>` row's `{row.name}` compiles to). Two flights land in turn.

**Observed** (`dv18-projection-relanding.mjs`): after the second landing the
rows still read `"apple,apricot"` (expected `"apple,applesauce,apple pie"`).
`direct` (one render effect reading `row.name`) follows both. Bisected:
fine at `f811097`, broken at `1212b77` (#4280) and on `2f7dc84`.

---

## DV-8b — `pending?` over a keyed projection (ours, not Solid's)

`dv8b-projection-pending.mjs [proxy|keys|length] [boundary|none]`. The probe
`isPending(() => rows)` reads nothing — Solid judges the reads a probe's
thunk makes, never its return value (RULES-DERIVED D-24, A23) — so it is
`false` while the memo under the projection re-asks. `keys` (what
`__rt.isPending` now does for a structured value) and `length` report
`searching` as S-ai2-search's instants 2 and 4 expect.

---

## DV-19 — `latest()` over a pending guess answers the re-asked truth once a re-ask lands under it — filed as solidjs/solid#4689; ruled a bug in #4695 (decision 3), not built

**Rule.** Spec H-11 and H-7: `latest x` of a guess the screen shows answers the guess until its hold commits, even after
an answer corrected the graph (Solid D-22, D-34, decision 3 of #4695; S-latest-reask instants 4 and 5).

**Shape.** A keyed `createOptimisticStore` over an async loader; an action guesses a row away and awaits; the store is
refreshed from outside the action and that answer lands while the guess is pending. The same with `createOptimistic`
over `createSignal(async)`.

**Expected.** `store.length` 2, `latest(() => store.length)` 2.

**Observed on 2.0.0-rc.21 (next @ 2105ffb8).** `store.length` 2, `untrack` 2, `latest` 3. Before the re-ask lands,
`latest` is 2. The signal form: `detail().title` "New", `latest` "Old".

**Found by** the round 8 timing fuzzer on the chain4 reference desk, regraded on rc.21 (2026-11-05): a tab count read
with `latest issues` beside a list with a close in flight.

---

## DV-20 — a store read only by effects reverts at the action's end, before the action's refresh lands, once an outside re-ask has landed under it — filed as solidjs/solid#4690

**Rule.** Spec 06 D-35: an action's `refresh` is authoritative work in flight; the guess waits for that answer.

**Shape.** An optimistic store (object, array, keyed, or `createOptimistic` over a signal); an action guesses, awaits
its write, then `refresh`es the store; the store is refreshed from outside the action and that answer lands while the
guess is pending; the write lands.

**Expected.** Every reader keeps the guess until the action's re-ask lands.

**Observed on 2.0.0-rc.21.** A text node under `<Loading>` keeps it. An effect with nothing rendering the store sees
the old truth once the write lands, until the re-ask lands. An effect beside a rendered reader keeps it. Without the
outside re-ask every reader keeps it. An `effect` over a source nothing renders is a legal `.rx` program, so
S-guess-reask-refresh's effect-only variant records it (instants 5 and 6).

