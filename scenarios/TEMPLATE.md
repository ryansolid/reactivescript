# S-<area>-<n> — <one-line name>

Rules exercised: <ids>. Solid scenario mirrored (holds only): S-<n>.

## Program

```rx
export default component App() {
  <declarations, then the view (07; MO-1c)>
}
```

## Frames

| instant | action | frame | effect / probe verdicts |
| ------- | ------ | ----- | ----------------------- |

## Rejected variants

| fragment | rule | verdict |
| -------- | ---- | ------- |

## Mechanics (for writing scenarios)

- `## Program` holds a fenced program, or a line `file: ../examples/x.rx`.
- `## Modules` (09): fences beginning `-- module: ./x.rx` are modules every
  program in the scenario may import; a `file:` program finds its modules
  beside it on disk.
- The frame is the view's text: reader values and text nodes concatenated in
  order, whitespace collapsed to single spaces and trimmed; adjacent elements
  add no separator (write `{" "}` or a text node where one is wanted). Text
  is JSX's (07 §4): indentation and line breaks between elements are not
  text.
- Rows: `mount`, `handler \`stmts\`` (imperative statements; may call actions
  and read or write any live binding by name, including a region's locals
  while it is live), `resolve x v` / `reject x "msg"` (equation `x`'s current
  flight), `resolve "key" v` (a flight by key — `name:` + arguments formatted
  as values, strings and numbers bare, objects/arrays as JSON; resolving a
  key again is another landing of a stream, which `await*` reads and a plain `await` ignores; a program must not issue two flights with the same key), `(effect)` (the instant an
  apply block's writes opened).
- `| effect |` column: the instant's `log(...)` calls, `;`-separated.
- `## Variant: …` tables replay the base table up to the first listed
  instant, then override; with their own program fence, prefix rows only
  drive state.
- `## Rejected variants`: fences starting `-- reject: RULE` (or `-- warn:
  CODE`), optional `-- handler: stmts` lines; `-- types: CODE` is refused
  by the type layer (TypeScript's `TSnnnn`, or a rule it states as a type,
  such as `WIRE_VALUE`) and checked by `npm run -s types` only.
- `## Divergences`: `- oracle "<table>" instant N: \`frame\` — why` records
  what Solid 2.0 shows where the spec rules otherwise; `- server "<table>"
  instant N: …` what Solid's server render shows (10, `ref/ssr/`);
  `- hydrated "<table>" instant N: …` what Solid's client shows once it has
  taken a served page over (the hydrated run stops there).
- `## Hydration window` (10 SV-3b): `- "<table>" instant N: \`frame\` — why`,
  the ruled frame of a client that took the page over while a server
  answer was still out (the node does not follow its inputs until that
  answer lands); checked by `npm run -s ssr`, and the hydrated run stops
  there.
- `## Server frames` (10): rows `mount`, `resolve …`, `reject …` and the
  frame a browser shows from the server's stream after each — checked by
  `npm run -s ssr` only.
- A client question's landing (10 SV-7b: a flight of `client` JS) is
  written by key, `resolve "viewport:" 1024`; the server runner ends the
  stream before it, and the browser lands it once it has the page.
- `## Before hydration` (10 SV-3e): `mount`, then user events on the served
  page — `click "<selector>"`, `input "<selector>" "<text>"` — then
  `hydrate`, then ordinary rows; `npm run -s ssr` only. Every other table's mount and landings are also
  served and checked against the client's frames (SV-1).
- Failures (04 R-f): the prelude's `fetch` and every `./api` import return
  JS promises, which fail with `Error`, so a program that reads one has an
  `errored` above the reader — the ports put one at the root
  (`errored fallback(e) { <p>error: {e.message}</p> } { … }`), which shows
  nothing unless a reader fails. A ported action that awaits wraps its body
  in `try { … } catch {}` (R-f-6): the frames are DV-2's either way. The
  prelude's `fail(msg)` throws synchronously — a panic, not a failure
  (R-f-3).
