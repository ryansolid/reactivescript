# S-region-7 — downstream registration is an effect with a cleanup; context carries the writes

Rules: RG-7, O-4, W-6, O-2, O-3, EF.

The concrete shape: a form with two inputs, each telling the form "I am
here and I am valid/invalid" so the form can say whether the whole thing
is valid. Each input registers itself from an effect and the effect's
cleanup unregisters it when the input goes away. Both inputs mount in the
same instant, so both register in the same instant: the writes are
functional (`fields := f => [...f, row]`, W-6) and compose — with plain
value writes the second would overwrite the first and one input would be
lost. Storing a value is not an escape (O-3 is about closures capturing
region-local names); re-registration on change is the effect re-running.
The form owns `rows`, so only the form writes it (O-4): it provides
actions that say what a field may do, add itself and remove itself,
and nothing else. (Until 2026-10-31 the context carried the source itself,
RG-7c, and a field wrote `use fields := …` with any value it liked.)

## Program

```rx
type Row = { ok: boolean }
context fields: { add: (r: Row) => void; remove: (r: Row) => void }   // RG-7: declared; it carries the writes the form allows (O-4)
component Form(props) {
  source rows := []
  action add(r) { rows := f => [...f, r] }
  action remove(r) { rows := f => filter(f, x => x != r) }
  provide fields = { add: add, remove: remove }
  valid = every(rows, f => f.ok)
  <div>{props.children} <p>{len(rows)} {valid ? "valid" : "invalid"}</p></div>
}
component Field(props) {
  ok = props.value != ""
  reg = use fields
  effect (ok) {
    let row = { ok: $0 }
    reg.add(row)
    () => { reg.remove(row) }
  }
  <i>{props.value}</i>
}

export default component App() {
  source showEmail := true
  source name := ""
  source email := ""
  <Form>
    <Field value={name} />
    {if showEmail { <Field value={email} /> }}
  </Form>
}
```

## Frames

| instant | action                        | frame             |
| ------- | ----------------------------- | ----------------- |
| 0       | mount                         | `0 valid`         |
| 1       | (effect)                      | `2 invalid`       |
| 2       | handler `name := "a"`         | `a 2 invalid`     |
| 3       | (effect)                      | `a 2 invalid`     |
| 4       | handler `email := "e"`        | `ae 2 invalid`   |
| 5       | (effect)                      | `ae 2 valid`     |
| 6       | handler `showEmail := false`  | `a 2 valid`       |
| 7       | (effect)                      | `a 1 valid`       |
| 8       | handler `showEmail := true`   | `ae 1 valid`     |
| 9       | (effect)                      | `ae 2 valid`     |

Registration lands one instant after the render that caused it (an
effect's writes begin the next instant, EF-5); the cleanup unregisters when
the email field's region ends (instant 6→7). The effect and its cleanup
keep `add` and `remove` in step: nothing calls one without the other.

## Rejected variants

```rx
-- reject: RG-7b
context fields: { add: (r: unknown) => void }
component Field(props) {
  ok = props.value != ""
  <i>{props.value} {(use fields).add ? "y" : "n"}</i>
}

export default component App() {
  <Field value={"x"} />
}
```

No provision for `fields` above the field.
