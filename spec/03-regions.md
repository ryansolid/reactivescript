# 03 — Regions

**Status: OPEN (2026-10-21).** Ownership, lifetime, and the regions that `if`,
`for`, components, boundaries and effects introduce. Synchronous only; holds
(05) add nothing here except that a region's *mount* can be held.

A region is a lexical scope with a lifetime (V-8). Everything declared in a
region — sources, equations, effects, readers, nested regions — is released
when the region ends. Regions nest; the program is the root region.

---

## O — Ownership

- **O-1 (Every declaration has a region).** A source, equation, effect, or
  reader is declared in exactly one region: the innermost enclosing block.
  There is no unowned declaration.
- **O-2 (Release).** When a region ends: its readers leave the view, its
  sources and equations cease to exist, its nested regions end first
  (innermost out), and its effects' cleanups run (EF-5) — in the observe phase
  of the instant that ended it, before any apply block of that instant, since
  cleanups are imperative. Nothing outside the region may
  hold a reference to any of them afterward (O-3 is the only way out).
- **O-3 (Escape).** A closure that captures a name declared in region `R`
  may not be stored into a source or a value of a region that outlives `R`;
  the program is rejected (CN-2). Storing a row-local closure into a
  module-level source is the shape this refuses — a stale read waiting to
  happen (Solid: the disposed-read error is this rule's runtime shadow).
  Storing a *value* is never an escape: a value is a value. The earlier
  `escape` keyword is withdrawn, and so is a `lend` construct considered on
  2026-10-22 — downstream registration (a child adding itself to a store
  its provider owns) is an effect with a cleanup, through context (RG-7,
  S-region-7); it needs no construct, only composable writes (W-6).
  - **O-3a (Through names and calls).** A closure is stored however it
    gets there: through a `let`, through an equation whose value holds
    it, or as part of what a function returns. A closure an instantiation
    returns (RG-6) captures the instance, and the instance lives as long
    as the region of the call. So a counter made in a row cannot be stored
    in a module source, and one made in `App` can be stored in `App`'s
    own sources. A closure that is called is applied, not stored: what
    the call returns is stored, which holds a closure only if the called
    one makes one (`c.get()` stores a number). The same holds for a
    closure handed to a prelude function (`map`, `filter`, `every`).
  - **O-3b (Through props).** A prop's value belongs to the caller, so
    what a closure passed as a prop captures is the caller's. A component
    that stores a prop where the stored value outlives the component
    (a source outside it, or a provision above it) is checked where it
    is applied: the closure passed for that prop must not capture a name
    that ends sooner than that place. Handing the prop on to a component
    that stores it counts as storing it. Across modules this is in the
    signature (09 MO-3). (Found by #15, 2026-10-27: both holes accepted a
    row-local closure stored in a module source.)
- **O-4 (Writer scope).** [ruled 2026-10-31] A source is written only
  through its own name, by imperative code in its declaring region or a
  region nested in it (lexically: its handlers, apply blocks and actions).
  Every other way of reaching it is a read: a prop (RG-4b), a parameter of
  either kind (E-9), a local or field bound from it, a context (RG-7), an
  import (MO-2a) — at every path into a store too. To let other code
  write it, the owner passes an action (or an `on*` handler) that writes
  it, so the owner decides what a write may be: Solid's read/write
  segregation, checked statically, nothing added at run time. A write
  through any of these is `WRITE_TO_NON_SOURCE`, which names the fix.
  - **O-4a (Known gap).** O-3 does not yet follow a closure handed to an
    action as an argument and stored by it (`register(() => v)` where
    `register` stores its parameter in an outer source). The same gap
    exists for an `on*` handler prop that stores its argument. Before
    RG-7c was withdrawn, a closure stored through a `source` context was
    caught; that program now goes through a provided action, so it falls
    in this gap.
- **O-5 (Inference).** Regions are never annotated. The compiler assigns every
  declaration its region syntactically and checks O-3 by the escape analysis of
  closures and stored references.

---

## RG — Region-introducing forms

### RG-1 Conditional

`if c { A } else { B }` in a view. `c` is an equation. Exactly one of `A`, `B`
is a live region at any instant; the other does not exist.

- **RG-1a (Dispose and recreate).** When `c`'s truthiness changes, the live
  branch region ends (O-2) and the other is created fresh in the same instant:
  its sources re-run their initializers (E-4), its effects run their first
  apply (EF-2). A branch keeps no state across being left and re-entered.
- **RG-1b (Equality of the condition).** The branch switches only when `c`'s
  truthiness changes, not when `c` changes to another truthy value (E-6 on
  `Boolean(c)`). A truthy→truthy change is seen through RG-1c, not by
  recreation.
- **RG-1c (Narrowed binding).** Inside the branch taken by `if (x) { … }` where
  the condition is a bare reactive name, `x` denotes an equation equal to the
  outer `x` with the falsy case removed from its type. It keeps updating while
  the branch is live. (Solid: `<Show when={x}>{(x) => …}</Show>`'s narrowed
  accessor, without the callback.) Compound conditions narrow nothing.

### RG-2 Repetition

`for x in xs { Decl*; Markup }` in a view. `xs` is an equation over an
ordered collection. Each element has a row region.

- **RG-2a (Identity).** In core, rows are identified by element identity
  (`Object.is`). A row region lives while an identical element is present in
  `xs`; a reorder moves the region; an element that disappears ends its region;
  a new element creates one. Duplicates get one region per occurrence, in
  order. (Solid: `<For>` default. Keyed identity: 06-stores ST-4.)
- **RG-2b (Row binding is constant).** Within a row, `x` is a constant for the
  row's lifetime — it cannot change without the row being replaced. The row's
  index is an equation. (Structured mutation of `x` in place is 06-stores'
  question; in core, values are immutable.)
- **RG-2c (Row declarations).** `Decl*` inside the row are declared in the row
  region: a `source` per row re-initializes only when the row is created; an
  equation per row may read `x`, the index, and anything in enclosing regions.

### RG-3 Effects

`effect (…) B` is a region: its apply block's cleanup (EF-5) is the region's
release. An effect cannot declare sources, equations, or nested effects inside
`B` (SC-2 has no declarations), so the region contains only the cleanup.

### RG-4 Components

A component is a function from a props value to a region whose tail is a view.

- **RG-4a (Application is a view form).** `<C attr={e} …>children</C>` is
  markup. It may appear only in a view; there is no expression-position
  application. Applying `C` creates a region nested in the view's region, with
  the view's lifetime (an `if` branch or `for` row that contains `<C/>` owns
  it).
- **RG-4b (Props are one structured equation).** `props` is a single value
  whose fields are equations: `props.x` and `{ x } = props` are projections and
  keep updating. A prop is never a snapshot unless the body takes one (E-4,
  `peek`). Spread, rest, `merge`, and `omit` are operations on this value
  (06-stores treats its path semantics). Named parameters are not a separate
  form; destructuring covers the signature use.
- **RG-4c (Children).** `children` is a view value evaluated in the *caller's*
  region: its readers are the caller's, its lifetime is the caller's, and the
  child only decides where it is placed. A child that needs to create its
  content more than once, or conditionally own it, asks for a function prop
  instead, which is ordinary.
- **RG-4d (No return channel).** A component body evaluates to its view and
  nothing else. To expose a value upward, the caller passes a handler (or an
  action) the child calls: a source passed as a prop is read-only in the child
  (O-4). (Solid: `ref` props.)

### RG-6 Instantiation

A call to a function with a `ref` parameter or a node-declaring body (E-9).

- **RG-6a (Once, in the caller's region).** The call creates a region nested
  in the region of the call site; the body's sources, effects, and nested
  regions are owned by it. The call is not re-evaluated; its result is a value
  (often an equation) bound in the caller.
- **RG-6b (Arguments).** Ref arguments are equations passed by reference and
  keep updating inside the body. Value arguments are snapshots at
  instantiation (E-4). An expression passed to a ref parameter is wrapped as an
  equation at the call site.
- **RG-6c (Composition).** Pure transforms compose by lifting (`double(count)`
  is an equation); primitives compose by instantiation (`debounce(ref query,
  300)` owns an effect). A function's kind is visible in its signature; the
  call site need not know which it is, only that the first re-evaluates and
  the second does not.

### RG-7 Context

Three things, in three places (ruled 2026-10-23: a context is declared):

```rx
context theme: Theme = defaultTheme     // declared: once, at module level — what the context is (Solid: createContext)
provide theme = settings.theme          // provided: in a component's block — its value for the tree beneath (the Provider)
palette = (use theme).palette           // used: in any region beneath — the nearest provision above (useContext)
```

- **RG-7a (Declare).** `context name: T` declares a context. The
  declaration is its identity: `provide` and `use` name it lexically, like
  any name, so it is imported and aliased like a value, and two modules
  that each declare `context theme` declare two contexts (09 MO-7). A
  `provide` or `use` of a name that is not a context is `NOT_A_CONTEXT`; of
  an undeclared name, `UNBOUND`. A context is not a value: `{theme}` is
  `CONTEXT_AS_VALUE`.
- **RG-7b (Provide, use).** `provide name = e` in a region makes `e` the
  context's value for every region *instantiated beneath* it — the
  instantiation chain (the tree of views), not the lexical one. `use name`
  reads the nearest provision above; it is an equation, and reads of it
  track. A `use` with no provision above on some path of the static
  application tree is `CONTEXT_NOT_FOUND` — unless the context has a
  default, `context density: number = 1`, which is the value where nothing
  above provides it. A component body sees the caller's provisions, never
  the caller's locals.
- **RG-7c (Writing through a provision) — withdrawn 2026-10-31.** A
  context is read beneath its provision; `use x := …` is
  `WRITE_TO_NON_SOURCE` (O-4) and `context x: source T` is
  `SOURCE_CONTEXT`. A provider that lets readers write provides the
  writes it allows, as actions in the context's value:
  `context fields: { add: (r: Row) => void; remove: (r: Row) => void }`,
  `provide fields = { add: add, remove: remove }`. This is how a rendered
  child registers with its provider — an effect that calls `add` and
  calls `remove` in its cleanup (S-region-7). (Until 2026-10-31 the
  provision *was* the source, and a child could write any value to it.)
- **RG-7e (Rows).** A context's rows are the reader's rows at a `use`. When
  the context's type writes row words (`context user: pending
  fails(Error) User`), or the context is exported, its type is the
  contract: every provision (and the default) is checked against it
  (`ROW_NARROWER_THAN_INFERRED`), and every `use` has exactly those rows.
  An exported context with no row words promises none. Otherwise — a
  module's own context — the rows are inferred from its provisions in that
  module (CN-4a: checked where written).
- **RG-7d.** Solid: `createContext` (the declaration; a default is its
  default value) / `useContext`; a provision is the Provider's value.

### RG-5 Boundaries

`loading` and `errored` are regions whose content is a nested region that the
boundary can take out of the current instant (05-holds). In the synchronous
fragment they are inert wrappers.

---

### RG-8 Portals (ruled 2026-10-25: Solid's `Portal`)

`portal { decls; view }` and `portal to(e) { … }` (07 §4).

- **PT-1 (Owned here, shown elsewhere).** A portal is a region owned where
  it is written: it opens and is disposed with its parent region (RG-1a),
  its readers' pending and failures go to the boundaries above it there,
  `use` finds the provisions above it there (RG-7b), and its handlers write
  what any handler there may (O-4). Its view is placed at the end of the
  document, or in `e`, an element. A frame shows the page's text, then
  ` » ` and what portals show.
- **PT-2 (Held with its region).** What a portal shows is placed when its
  region is: behind a fallback it waits for the reveal (Solid D-19,
  S-solid-23).
- **PT-3 (Client-only).** The server renders nothing for a portal; the
  browser renders it once it has taken the page over. So a client question
  read inside a portal is held by it (SV-7b), and data that should come from
  the server is read above the portal and passed in.
- **PT-4 (Its place).** For the content model (10 SV-7d) a portal's view is
  at the end of `<body>`: a `<tr>` there is refused.

Executable: S-solid-23, S-region-8.

## Scenarios

- `S-region-1`: `if` branch with a source — state resets on re-entry (RG-1a).
- `S-region-2`: truthy→truthy change keeps the branch; narrowed binding
  updates (RG-1b, RG-1c).
- `S-region-3`: `for` reorder moves rows; duplicate elements; row-local source
  survives reorder, resets on remove/add (RG-2a, RG-2c).
- `S-region-4`: a closure declared in a row stored into an outer source —
  rejected without `escape` (O-3).
