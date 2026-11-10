# S-solid-46 — the content a display-ahead branch opens reads the screen, whoever opened the hold (Solid S-46; D-1, D-25)

Rules: H-7, H-8, RG-1.

## Program

```rx
export default component App() {
  source id := 0
  detail = await fetch("d:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><span>{id}</span> <span>{detail}</span> {if latest id > 0 { <span>{id}</span> } else { <p>[none]</p> }}</div>
  }
}
```

## Frames

| instant | action              | frame         |
| ------- | ------------------- | ------------- |
| 0       | mount               | ``            |
| 1       | resolve detail "d0" | `0 d0 [none]` |
| 2       | handler `id := 1`   | `0 d0 [none]` |
| 3       | resolve detail "d1" | `1 d1 1`      |

Instant 2: the condition opens ahead (`latest` asked), but the branch is a
mount whose first pass read the held write plainly: born held (Solid D-1,
decision 4 of solidjs/solid#4695), it does not attach until the landing, and
the `else` arm stays. A plain `id` means one thing on the whole screen.
Rejected: `0 d0 1` (two plain reads of one source disagreeing), `0 d0 0` (the
branch attached with the committed value), `0 d0` (attached with its slot
empty).

## Variant: the content reads `latest id`

```rx
export default component App() {
  source id := 0
  detail = await fetch("d:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><span>{id}</span> <span>{detail}</span> {if latest id > 0 { <span>{latest id}</span> } else { <p>[none]</p> }}</div>
  }
}
```

| instant | action              | frame         |
| ------- | ------------------- | ------------- |
| 0       | mount               | ``            |
| 1       | resolve detail "d0" | `0 d0 [none]` |
| 2       | handler `id := 1`   | `0 d0 1`      |
| 3       | resolve detail "d1" | `1 d1 1`      |

The read that asks sees ahead, at its own site.

## Variant: the content is inside a `loading`

```rx
export default component App() {
  source id := 0
  detail = await fetch("d:" + id)

  errored fallback(e) { <p>error: {e.message}</p> } {
    <div><span>{id}</span> <span>{detail}</span> {if latest id > 0 { {loading fallback { <p>[fallback]</p> } { <span>{id}</span> }} } else { <p>[none]</p> }}</div>
  }
}
```

| instant | action              | frame             |
| ------- | ------------------- | ----------------- |
| 0       | mount               | ``                |
| 1       | resolve detail "d0" | `0 d0 [none]`     |
| 2       | handler `id := 1`   | `0 d0 [fallback]` |
| 3       | resolve detail "d1" | `1 d1 1`          |

S-solid-31's form: the fresh boundary catches the born-held read.

## Divergences (DV-23)

- oracle "Frames" instant 2: `0 d0`

Solid's S-46 plain row is ruled, not built (#4695, decision 4): today the
branch attaches with its slot empty. The variants match.
