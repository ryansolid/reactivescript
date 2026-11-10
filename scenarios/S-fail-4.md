# S-fail-4 — a pane that borrows another pane's data catches the borrowed read

Rules: R-f-4, R-f-5, R-6, D-41.

## Program

```rx
component Detail(props) {
  item = await fetch("item:" + props.id)
  heading = props.titles[props.id] catch (e) => item.title
  errored fallback(e) { <p>detail failed: {e.message}</p> } {
    <h2>{heading}</h2>
  }
}

export default component App() {
  titles = await fetch("titles")
  <div>
    {errored fallback(e) { <p>list failed: {e.message}</p> } { <p>{titles.length}</p> }}
    <Detail id={1} titles={titles} />
  </div>
}
```

The list and the detail each have their own boundary. The detail borrows
the list's titles for its heading, and catches that read: when the list
fails, the list shows the failure and the detail falls back to its own
answer.

## Frames

| instant | action                                      | frame                        |
| ------- | ------------------------------------------- | ---------------------------- |
| 0       | mount                                       | ``                           |
| 1       | reject titles "down"                        | ``                           |
| 2       | resolve item {"title":"Login"}              | `list failed: downLogin`     |

Instant 1: the mount still waits for `item` (no `loading` boundary, H-2).
Instant 2: the list's failure stays in the list (`catch` discharges it in
the detail, R-f-4), and the detail shows its own answer.

Without the `catch` the program is accepted (R-f-11 was withdrawn), and the
list's failure would reach the detail's boundary: the detail would show
"detail failed: down" for a request it did not make, and its retry would ask
`item` again, not `titles`. Found in the round 10 AI eval (desk rx-2).
