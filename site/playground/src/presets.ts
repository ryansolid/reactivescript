export type Preset = { id: string; title: string; blurb: string; files: Record<string, string> };

const users = {
  "users.d.rx": `export pure fn fetchUser(id: number) rejects(NotFound)
export error NotFound
`,
};

export const presets: Preset[] = [
  {
    id: "source",
    title: "Source and equation",
    blurb: "A source is a signal you write; an equation is a memo over what it reads.",
    files: {
      "main.rx": `export default component App() {
  source count := 0          // a source: __rt.source, over createSignal
  double = count * 2         // an equation: __rt.memo, over createMemo
  parity = count % 2 == 0 ? "even" : "odd"

  <div>
    <button type="button" onClick={() => { count := count + 1 }}>
      Clicked {count} times
    </button>
    <p>double: {double}, {parity}</p>
  </div>
}
`,
    },
  },
  {
    id: "await",
    title: "await, loading, errored",
    blurb: "One equation with an await lowers to two memos: the hoisted await keyed on id, and the rest reading suffix.",
    files: {
      "main.rx": `import pure { fetchUser } from "./users"

export default component App() {
  source id := 1
  source suffix := "!"
  label = (await fetchUser(id)).name + suffix

  <section>
    {errored fallback(e) { <p class="error">{e.message}</p> } {
      {loading fallback { <p>Loading…</p> } {
        <h2 class={pending? label ? "stale" : ""}>{label}</h2>
      }}
    }}
    <button type="button" onClick={() => { id := latest id + 1 }}>Next user ({latest id})</button>
    <button type="button" onClick={() => { suffix := suffix + "!" }}>More excitement</button>
  </section>

  <style>
    .stale { opacity: 0.5; }
    .error { color: crimson; }
  </style>
}
`,
      ...users,
    },
  },
  {
    id: "action",
    title: "action with guess",
    blurb: "guess shows a value now and takes it back by itself if the action fails.",
    files: {
      "main.rx": `import pure { loadName, saveName } from "./names"

export default component App() {
  source name = await loadName()   // a source with a question: it can take a guess
  source draft := ""
  source saveError := ""

  action save(next: string) {
    guess name := next
    affects name
    onFlush(() => { saveError := "" })
    try {
      let saved = await saveName(next)
      name := saved
    } catch (e) {
      saveError := e.message
    }
  }

  <section>
    {errored fallback(e) { <p class="error">{e.message}</p> } {
      {loading fallback { <p>Loading…</p> } {
        <h2 class={pending? name ? "saving" : ""}>Hello, {name}</h2>
      }}
    }}
    <input value={draft} onInput={(e) => { draft := e.currentTarget.value }} />
    <button type="button" onClick={() => save(draft)}>Save</button>
    {if saveError != "" { <p class="error">{saveError}</p> }}
  </section>

  <style>
    .saving { opacity: 0.6; font-style: italic; }
    .error { color: crimson; }
  </style>
}
`,
      "names.d.rx": `export pure fn loadName()
export pure fn saveName(name: string)
`,
    },
  },
  {
    id: "control",
    title: "for and if",
    blurb: "for and if are expressions in the view; they lower to Solid's For and Show.",
    files: {
      "main.rx": `names = ["Ada", "Grace", "Anders", "Brendan"]

export default component App() {
  source guests: string[] := []
  count = guests.length

  <section>
    <button type="button" onClick={() => { guests := gs => [...gs, names[gs.length % names.length]] }}>
      Sign the guestbook
    </button>
    <button type="button" onClick={() => { guests := [] }}>Clear</button>
    <ul>
      {if count == 0 {
        <li class="empty">No signatures yet.</li>
      } else {
        {for guest in guests {
          <li>{guest}</li>
        }}
      }}
    </ul>
  </section>
}
`,
    },
  },
  {
    id: "projection",
    title: "Projections: key and draft",
    blurb: "A keyed equation and a draft both become createProjection: rows keep identity by key, a draft writes only what changed.",
    files: {
      "main.rx": `export default component App() {
  source todos := [
    { id: 1, title: "Write the spec", done: true },
    { id: 2, title: "Port the crate", done: false },
    { id: 3, title: "Ship the playground", done: false },
  ]
  source picked := 2
  source last := 0

  open key id = todos.filter(t => !t.done)             // a keyed equation: createMemo + createProjection
  marks = draft(pre marks -> {}) {                      // a draft: createProjection over its own writes
    d[str(picked)] := true
    d[str(last)] := false
  }

  <ul>
    {for todo in open {
      <li class={marks[str(todo.id)] ? "picked" : ""}>
        <button type="button" onClick={() => { last := picked; picked := todo.id }}>{todo.title}</button>
      </li>
    }}
  </ul>

  <style>
    .picked { font-weight: 600; }
  </style>
}
`,
    },
  },
  {
    id: "style",
    title: "Scoped style",
    blurb: "A component's <style> is scoped to its own elements by a class hash.",
    files: {
      "main.rx": `export default component App() {
  source lit := false

  <style>
    .card {
      padding: 1rem 1.25rem;
      border-radius: 12px;
      border: 2px solid #5b9be6;
      transition: background 0.2s;
    }
    .card.on { background: #f0b44c; color: #0c1829; }
    button { font: inherit; }
  </style>
  <div class={lit ? "card on" : "card"}>
    <p>The card is {lit ? "lit" : "dark"}.</p>
    <button type="button" onClick={() => { lit := !lit }}>Toggle</button>
  </div>
}
`,
    },
  },
];
