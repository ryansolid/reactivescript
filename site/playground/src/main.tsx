import { render } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { compile, ENTRY, init, type Diagnostic } from "./compile";
import { highlight, highlightRx } from "./highlight";
import { noteFor, primsIn } from "./explain";
import { presets } from "./presets";
import { decode, encode } from "./share";
import { formatSolid } from "./format";
import "./style.css";

const GUIDE = "https://github.com/solidjs/reactivescript/blob/main/guide/diagnostics.md";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function lineCol(text: string, line: number, column: number) {
  let i = 0;
  for (let l = 1; l < line; l++) {
    const n = text.indexOf("\n", i);
    if (n < 0) return text.length;
    i = n + 1;
  }
  return Math.min(i + column, text.length);
}

function Playground(props: { initial: { files: Record<string, string>; active: string; preset?: string } }) {
  const [files, setFiles] = createSignal<Record<string, string>>(props.initial.files);
  const [active, setActive] = createSignal(props.initial.active);
  const [preset, setPreset] = createSignal(props.initial.preset ?? "");
  const [copied, setCopied] = createSignal(false);
  const [explain, setExplain] = createSignal(true);

  const result = createMemo(() => compile(files(), "dom"));
  const lastGood = createMemo<ReturnType<typeof compile> | undefined>((prev) => (result().app.modules ? result() : prev));
  const stale = () => !result().app.modules;
  const diagnostics = () => result().diagnostics;
  const failure = () => result().app.error;
  const modules = createMemo(() =>
    Object.entries(lastGood()?.app.modules ?? {})
      .sort(([a], [b]) => Number(b === ENTRY) - Number(a === ENTRY))
      .map(([p, m]) => ({ path: p, jsx: m.jsx ?? "" })),
  );
  const rawJsx = createMemo(() => modules().map((m) => m.jsx).join("\n\n"));
  const [solid, setSolid] = createSignal<{ raw: string; code: string; error?: string }>({ raw: "", code: "" });
  createEffect(
    () => rawJsx(),
    (raw) => {
      Promise.all(modules().map((m) => formatSolid(m.jsx).then((r) => ({ ...r, code: m.path === ENTRY ? r.code : `// ${m.path}\n${r.code}` }))))
        .then((rs) => rawJsx() === raw && setSolid({ raw, code: rs.map((r) => r.code).join("\n"), error: rs.find((r) => r.error)?.error }))
        .catch((e) => rawJsx() === raw && setSolid({ raw, code: raw, error: String(e?.message ?? e) }));
    },
  );
  const shown = () => (solid().raw === rawJsx() ? solid().code : "");
  const codeHtml = createMemo(() =>
    shown()
      .split("\n")
      .map((l) => {
        const n = explain() ? noteFor(l) : undefined;
        const note = n
          ? `<div class="note" data-testid="note">${/^\s*/.exec(l)![0]}<span><b>${esc(n.helper)}</b> → ${esc(n.text)}${esc(n.reads.length ? ` · reads ${n.reads.join(", ")}` : "")}</span></div>`
          : "";
        return `<div class="cl">${highlight(l, "javascript") || " "}${note}</div>`;
      })
      .join(""),
  );
  const prims = createMemo(() => primsIn(shown()));

  const text = () => files()[active()] ?? "";
  const editLines = createMemo(() => {
    const bad = new Set(diagnostics().filter((d) => d.file === "/" + active() && d.line).map((d) => d.line!));
    return highlightRx(text())
      .split("\n")
      .map((l, i) => `<span class="eline${bad.has(i + 1) ? " bad" : ""}">${l || " "}</span>`)
      .join("\n");
  });

  let textarea!: HTMLTextAreaElement;
  let backdrop!: HTMLPreElement;

  const update = (value: string) => {
    setFiles({ ...files(), [active()]: value });
    setPreset("");
  };
  const loadPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setFiles({ ...p.files });
    setActive("main.rx");
    setPreset(id);
  };
  const goTo = (d: Diagnostic) => {
    const name = d.file.replace(/^\//, "");
    if (name in files()) setActive(name);
    queueMicrotask(() => {
      const t = files()[active()] ?? "";
      const start = d.range ? lineCol(t, d.range.start.line, d.range.start.column) : lineCol(t, d.line ?? 1, 0);
      const end = d.range ? lineCol(t, d.range.end.line, d.range.end.column) : start;
      textarea.focus();
      textarea.setSelectionRange(start, Math.max(end, start));
    });
  };
  const addFile = () => {
    const name = prompt("New file name (an .rx module, a .d.rx declaration, or a .js module):", "util.rx");
    if (!name || name in files() || !/^[\w./-]+\.(rx|js|mjs)$/.test(name)) return;
    setPreset("");
    setFiles({ ...files(), [name]: name.endsWith(".d.rx") ? "export pure fn load()\n" : name.endsWith(".rx") ? "export n = 1\n" : "export const n = 1;\n" });
    setActive(name);
  };
  const removeFile = (name: string) => {
    if (name === "main.rx" || !confirm(`Remove ${name}?`)) return;
    const next = { ...files() };
    delete next[name];
    setPreset("");
    setFiles(next);
    setActive("main.rx");
  };
  const share = async () => {
    const hash = await encode({ files: files(), active: active() });
    history.replaceState(null, "", "#" + hash);
    await navigator.clipboard?.writeText(location.href).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // the URL keeps the program, so a reload or a shared link opens it again
  let hashTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => [files(), active(), preset()] as const,
    ([f, a, p]) => {
      clearTimeout(hashTimer);
      hashTimer = setTimeout(async () => {
        const hash = p ? `example=${p}` : await encode({ files: f, active: a });
        history.replaceState(null, "", "#" + hash);
      }, 300);
    },
  );

  const syncScroll = () => {
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value } = textarea;
      update(value.slice(0, s) + "  " + value.slice(end));
      queueMicrotask(() => textarea.setSelectionRange(s + 2, s + 2));
    }
  };

  return (
    <div class="shell">
      <header class="bar">
        <a class="brand" href="https://reactivescript.dev/" target="_blank" rel="noopener">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width="28" height="28" />
          <span>
            ReactiveScript <b>Playground</b>
          </span>
        </a>
        <label class="field">
          <span>Example</span>
          <select data-testid="example" value={preset()} onChange={(e) => loadPreset(e.currentTarget.value)}>
            <option value="" disabled>
              (edited)
            </option>
            <For each={presets}>{(p) => <option value={p.id}>{p.title}</option>}</For>
          </select>
        </label>
        <span class="spacer" />
        <span class="ms" data-testid="ms">
          {result().ms.toFixed(1)} ms
        </span>
        <button type="button" class="btn primary" onClick={share}>
          {copied() ? "Link copied" : "Share"}
        </button>
      </header>

      <Show when={presets.find((p) => p.id === preset())}>
        {(p) => <p class="blurb">{p().blurb}</p>}
      </Show>

      <main class="grid">
        <section class="pane editor-pane">
          <div class="tabs">
            <For each={Object.keys(files())}>
              {(name) => (
                <span class={`tab${active() === name ? " on" : ""}`}>
                  <button type="button" onClick={() => setActive(name)}>
                    {name}
                  </button>
                  <Show when={name !== "main.rx"}>
                    <button type="button" class="x" title={`Remove ${name}`} onClick={() => removeFile(name)}>
                      ×
                    </button>
                  </Show>
                </span>
              )}
            </For>
            <button type="button" class="tab add" title="Add a file" onClick={addFile}>
              +
            </button>
          </div>
          <div class="editor">
            <pre class="backdrop" aria-hidden="true" ref={backdrop} innerHTML={editLines() + "\n"} />
            <textarea
              ref={textarea}
              data-testid="editor"
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              value={text()}
              onInput={(e) => update(e.currentTarget.value)}
              onScroll={syncScroll}
              onKeyDown={onKey}
            />
          </div>
          <div class="diags" data-testid="diagnostics">
            <div class="label">
              Diagnostics <span class={`count${diagnostics().length ? " bad" : ""}`}>{diagnostics().length}</span>
            </div>
            <Show when={diagnostics().length || failure()} fallback={<p class="ok">The checker accepts the program.</p>}>
              <Show when={failure()}>{(f) => <pre class="err">{f()}</pre>}</Show>
              <ul>
                <For each={diagnostics()} keyed={false}>
                  {(d) => (
                    <li>
                      <button type="button" class="where" onClick={() => goTo(d())}>
                        {d().file.replace(/^\//, "")}:{d().range ? `${d().range!.start.line}:${d().range!.start.column + 1}` : d().line ?? "?"}
                      </button>
                      <a class="code" href={`${GUIDE}#${d().code.toLowerCase()}`} target="_blank" rel="noopener" data-testid="diag-code">
                        {d().code}
                      </a>
                      <span class="rule">[{d().rule}]</span>
                      <span class="msg">{d().message}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </section>

        <section class="pane out-pane">
          <div class="out-head">
            <span class="label">Solid primitives</span>
            <span class="hint">what the compiler's __rt calls are in Solid 2.0, for reading</span>
            <span class="spacer" />
            <label class="check">
              <input type="checkbox" checked={explain()} onChange={(e) => setExplain(e.currentTarget.checked)} data-testid="explain-toggle" /> Explain
            </label>
          </div>
          <Show when={stale() && lastGood()}>
            <p class="stale-note">Not compiled: showing the last output that compiled.</p>
          </Show>
          <Show when={solid().raw === rawJsx() && solid().error}>
            <p class="stale-note" data-testid="solid-error">
              Could not write this as Solid primitives ({solid().error}); showing the compiler's JSX instead.
            </p>
          </Show>
          <div class={`output${stale() ? " stale" : ""}`}>
            <pre class="code" data-testid="solid" innerHTML={codeHtml()} />
            <Show when={explain() && prims().length}>
              <div class="explain">
                <div class="label">What each primitive stands for in .rx</div>
                <table class="map" data-testid="explain">
                  <thead>
                    <tr>
                      <th>Solid</th>
                      <th>written in .rx as</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={prims()} keyed={false}>
                      {(p) => (
                        <tr>
                          <td>
                            <code>{p().name}</code>
                          </td>
                          <td>{p().from}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </div>
        </section>
      </main>
    </div>
  );
}

async function start() {
  await init();
  const fromHash = await decode(location.hash);
  const featured = presets.find((p) => p.id === (fromHash?.preset ?? "await")) ?? presets[0];
  const initial = fromHash?.files
    ? { files: fromHash.files, active: fromHash.active in fromHash.files ? fromHash.active : "main.rx" }
    : { files: { ...featured.files }, active: "main.rx", preset: featured.id };
  const root = document.getElementById("app")!;
  root.textContent = "";
  render(() => <Playground initial={initial} />, root);
}

start().catch((e) => {
  document.getElementById("app")!.innerHTML = `<pre class="err">The compiler did not load: ${String(e?.stack ?? e)}</pre>`;
});
