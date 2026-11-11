# Notes: settings page (examples/ai2/settings)

Modules: `theme.rx` (contexts only) ← `settings.rx` (server truth + actions),
`ui.rx` (Panel, ThemePicker, Appearance; imports only `theme.rx`) ←
`form.rx` (SettingsForm: owns the draft, provides both contexts) ← `main.rx`
(entry: errored → loading → page).

## Checker runs (3)

| run | command | diagnostics | did the message alone tell me the fix? | what I changed |
| --- | --- | --- | --- | --- |
| 1 | `check.ts main.rx` | `NOT_EXPORTED` ×5 (MO-6): `./theme.rx does not export Theme` / `Density`, `./settings.rx does not export Settings` | **Partly.** It told me *what* (those names cannot be imported), but the message is misleading: `theme.rx` does say `export type Theme`. I needed MO-6c ("`export type` declares a type name and binds nothing") to see that types never cross an import. | Removed the three type imports. The annotations (`Settings`, `Theme`, `Density` in `settings.rx`/`form.rx`) stay as unchecked text. |
| 2 | `check.ts main.rx` | none (`ok … (+4 modules)`) | — | — |
| 3 | `check.ts --signature main.rx` | none | — | Nothing. I ran this to confirm the rows: `settings: pending fails(Error)`, `validate: fails(NameRequired \| NameTooLong)`, `ThemePicker/Appearance uses(theme.rx#theme)`, `SettingsForm(props: {})`. |

## What the checker (or the language) made me write that I don't like

- **Types cannot be shared across modules (run 1).** `export type Settings` is
  accepted and then cannot be imported. So `form.rx` annotates
  `props: { initial: Settings }` with a name that is not in scope, and the
  checker says nothing because types are text. If I declared the type again in
  each module, the copies could drift apart. Either `import { type X }` should
  work, or `export type` should be refused. Accepting the export and refusing
  the import is the worst of both.
- **`nameError = (valid && "") catch (e: NameRequired | NameTooLong) => e.message`.**
  The checker did not force this; the language lacks something. To show a
  failure as a message next to the field, I have to map the *success* to a
  sentinel (`valid && ""`) so that the `catch` arm can supply the message.
  There is no expression meaning "the error of `e`, or nothing". Something like
  `failure? e` (a verdict, as `pending?` is) would make the field message
  `{failure? valid catch …}`. Without it, every field error repeats this idiom.
- **The `{" "}` separators in the markup are there for the frame format.**
  TEMPLATE says adjacent elements add no separator. Without them the predicted
  frames would read `compactProfile [compact]Display name…`. A real page would
  not have these.
- **`saveError` needs both a guess and a plain write on success.** I wrote
  `guess saveError := ""` so a new save clears the old message at once.
  But the source's truth is the last *plain* write (`"quota exceeded"`), so
  without `saveError := ""` after a successful `await`, the guess would revert
  and the old error would come back. It is correct per H-11, and easy to get
  wrong.
- I did not want any `catch` the checker forced. The one in `save` I would
  have written anyway (R-f-6 agrees). The root `errored` is required because
  `loadSettings` can reject, and I wanted it there anyway.

## Design choices the rules pushed me into

- **The theme context carries the draft's theme, not the saved theme.**
  RG-7c says a `source` context's provision *is* the source, and
  `use theme := …` writes it directly. If I provided `settings.rx`'s
  module-level state that way, ThemePicker would write module state without
  going through an exported action, which breaks requirement 5. (MO-2a would
  probably refuse a provision of an imported source anyway.) So `form.rx` owns
  `source draftTheme`, provides it, and ThemePicker previews the theme being
  edited. The checker accepted a *component-local* source as "one of the
  module's sources" (RG-7c's wording).
- **The draft lives in the form and is seeded once.** `source draft = settings`
  (a question) would have been shorter. But when a failed save reverts the
  `settings` guess, the draft would re-derive and lose the user's edits. So the
  form is mounted only inside `if settings`, and seeds
  `source draftX := peek(props.initial.x)`.
- **Retry is an exported action.** `refresh` is not a write (MO-2b lets
  `main.rx` refresh an imported question). I still exported
  `action retryLoad() { refresh settings }`, so that main never touches
  settings directly.

## Where the spec was ambiguous or silent, and what I assumed

1. **`peek` of a pending or failing value in a source initializer.** R-8 forbids
   imperative snapshots of pending values. E-4 makes `peek(...)` the initializer
   form. Neither says what `source x := peek(p)` does when `p` is pending or
   errored, and the checker drops `initial` from `SettingsForm`'s signature
   (`props: {}`), so the prop's `fails(Error)` row is never checked. I avoided
   the case by mounting the form only after `if settings` is truthy.
2. **A written type with no row words on a failing source**
   (`source settings: Settings = await …`). R-f-9 says "a written prefix that
   leaves `fails(…)` out of a value that fails" is `ROW_NARROWER_THAN_INFERRED`.
   The checker accepted it, so a bare TS type apparently is not a "prefix". I
   assumed that.
3. **Whitespace between elements on separate lines.** I assumed JSX's rule
   (TEMPLATE: "adjacent elements add no separator") and put `{" "}` wherever I
   predicted a space. Extra spaces collapse, so the frames depend only on there
   being *no* separator where I wrote none.
4. **Recovery of `errored` after `refresh`.** H-12 says the fallback leaves "when
   a value replaces the error". I assumed that happens automatically when the
   refreshed flight lands, even though the content readers were behind the
   fallback (S-solid-42 is cited for this).
5. **A guess closing an `if` branch** (`guess saveError := ""` hiding
   "Save failed" at once). H-7 says "a branch a lane condition opens is a
   mainline mount and attaches now". It does not explicitly say the same for a
   branch a lane condition *closes*. I assumed it is symmetric.
6. **`pending? settings` on the narrowed binding inside `if settings`**
   (RG-1c). I assumed the verdict is the source's, including `affects`.
7. **Scenario handlers naming form-local bindings** (`draftName`, `draft`).
   TEMPLATE allows "a region's locals while it is live". There is exactly one
   live SettingsForm, so the names are unambiguous.
8. **Flight keys for a structured snapshot.** I assumed the JSON follows the
   literal's key order (`name, theme, density`). I also assumed the scenario's
   `reject "saveSettings:{"name":…}" "msg"` quoting is parsed by its outer
   quotes, as in the task's own example. The inner `"` are not escaped.
9. **`refresh` inside an action.** AC-4 stages the landing into the open
   change. Here that gives the same frames as a plain handler would, because
   the error stays shown either way.
10. **`error NameRequired()` with empty params,** constructed as `NameRequired()`.
    The grammar allows `("(" Params ")")?`, and the checker accepted it.

## Confidence per predicted frame

| instant | confidence | rule relied on |
| --- | --- | --- |
| 0 mount | high | H-5 (armed boundary catches the pending `if` reader); RG-7b default |
| 1 reject load | high | R-6 / H-12; R-f-8 (`Error` with the string as message) |
| 2 retryLoad | medium | AC-4 quiet re-ask; H-12 "the error stays the display through a retry" |
| 3 resolve load | medium | H-12 recovery (assumption 4); RG-1 mount; E-4 seeding; RG-7b / RG-4c provisions through children |
| 4 empty name | high | R-f-2 / R-f-4 `catch` over a lifted `fn` that throws |
| 5 long name | high | RG-1b / RG-1c: truthy→truthy keeps the branch, narrowed value updates |
| 6 valid + theme | high | W-3 one instant; RG-7c provision as source |
| 7 save | medium-high | H-11 guess shows in its lane; AC-5 `affects`; H-7 probes never hold |
| 8 reject save | medium-high | AC-7 catch inside the change; H-11 guess corrected by the truth at the body's end; DV-2 not involved |
| 9 density | high | plain local write, RG-7b |
| 10 save again | medium | H-11 on `saveError` (a constant question); branch closing under a guess (assumption 5) |
| 11 resolve save | medium-high | H-11: an equal truth confirms silently; the plain `saveError := ""` truth |

(2026-10-31: RG-7c is withdrawn. The program now provides `{ current, pick }`, with `pick` an action
the form declares (O-4); the notes above describe the run as it was.)
