# S-server-3 — Client questions: what only the browser can answer is held on the server

Rules exercised: SV-7b, SF-5b; SV-1, SV-3; R-7.

## Modules

```rx
-- module: ./api.d.rx
// what only the browser knows
export client pure fn viewport()
export client pure fn timeZone()
```

## Program

```rx
import { viewport, timeZone } from "./api"
export default component App() {
  width = await viewport()
  zone = await timeZone() -> "UTC"

  errored fallback(e) { <p>error</p> } {
    <p>zone {zone}</p>{" "}
    {loading fallback { <p>measuring</p> } { <p>{width < 600 ? "narrow" : "wide"}</p> }}
  }
}
```

`width` awaits `client` JS with no first paint: a client question, held
on the server by the `loading` region its reader is in — the server sends
the fallback. `zone` has a first paint (R-7), so the server sends `UTC`
and the browser asks the question once it has the page. Neither is asked
on the server, so nothing about the browser can differ between the HTML
and the hydrated page: the browser draws its answers as ordinary landings.

## Frames

| instant | action                           | frame                          |
| ------- | -------------------------------- | ------------------------------ |
| 0       | mount                            | `zone UTC measuring`           |
| 1       | resolve "viewport:" 1024         | `zone UTC wide`                |
| 2       | resolve "timeZone:" "Europe/Paris" | `zone Europe/Paris wide`     |

Served, the stream is the mount alone (`zone UTC measuring`): the landings
are the browser's, after it has taken the page over.

## Rejected variants

```rx
-- reject: CLIENT_QUESTION_UNHELD
import { viewport } from "./api"
export default component App() {
  width = await viewport() catch (e) => 0

  <p>{width}</p>
}
```

Nothing holds it: on the server this page would never finish (Solid:
`ASYNC_OUTSIDE_LOADING_BOUNDARY`, at run time).

```rx
-- reject: CLIENT_QUESTION_UNHELD
import { viewport } from "./api"
export default component App() {
  width = await viewport() catch (e) => 0
  narrow = width < 600

  loading fallback { <p>…</p> } { <p>ok</p> }
  <p>{narrow}</p>
}
```

A value computed from a client question is one: its reader needs the hold.

```rx
-- reject: CLIENT_QUESTION_UNHELD
import { viewport } from "./api"
component Size(props) { <p>{props.w}</p> }
export default component App() {
  width = await viewport() catch (e) => 0

  <Size w={width} />
}
```

Through a prop: the component reads it where nothing holds it.

```rx
-- reject: CLIENT_NOT_AWAITED
import { viewport } from "./api"
export default component App() {
  width = viewport()

  <p>{width}</p>
}
```

SF-5b: the server has no `viewport`; in reactive scope a client call is a
question.
