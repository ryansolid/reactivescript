# S-surface-5 — a spread attribute, `{...e}`

Rules: 07 §4 (Markup), RG-4, RG-4b.

`{...e}` among an element's attributes gives it every field of `e`, as JSX
does. Parts merge in order and the last one that has a field wins, as
Solid's `merge`: an attribute after the spread overrides it, one before it
is a default. Each field keeps updating, as a named attribute does; on a
component, the spread is read where the component reads a field of it.

## Program

```rx
component Badge({ label, tone = "info", ...rest }) {
  <span>{label}:{tone}:{rest.count}:{rest.title}</span>
  <button {...rest}>open</button>
}

export default component App() {
  source extra: { count: number; tone?: string; title: string } := { count: 1, tone: "warn", title: "a" }

  <Badge label="x" {...extra} title="fixed" />
  <Badge tone="calm" {...extra} label="y" />
}
```

The first badge's `title` comes after the spread, so it is `fixed` whatever
`extra` holds; its `tone` comes from `extra`. In the second, `tone="calm"`
comes before the spread, so `extra.tone` wins while it has one.

## Frames

| instant | action                                         | frame                                  |
| ------- | ---------------------------------------------- | -------------------------------------- |
| 0       | mount                                          | `x:warn:1:fixedopeny:warn:1:aopen`     |
| 1       | handler `extra := { count: 2, title: "b" }`    | `x:info:2:fixedopeny:calm:2:bopen`     |

Instant 1: `extra` no longer has `tone`, so the first badge falls back to
its default and the second to the attribute before the spread.

## Rejected variants

```rx
-- reject: PARSE
export default component App() {
  source extra := { title: "a" }
  <p {extra}>hi</p>
}
```

An attribute in braces is a spread: `{...extra}`.

```rx
-- reject: UNHANDLED_FAILURE
component Card(props: { title: string }) {
  <h1>{props.title}</h1>
}

export default component App() {
  info = await fetch("info")
  loading fallback { <p>…</p> } {
    <Card {...info} />
  }
}
```

A spread passes `info`'s failure on with its fields: `Card` reads `title`,
so the read can fail with `Error`, and nothing above it catches.
