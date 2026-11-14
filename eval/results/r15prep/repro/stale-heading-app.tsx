import { For, Show, Loading, Errored, action, createMemo, createSignal, createOptimistic, refresh, latest, getObserver } from "solid-js";
import * as api from "./api.js";
import { assign, renameIssue, removeLabel } from "./api.js";

// one request per key while it is cached; an action's refresh forgets the key first
const cache = new Map<string, Promise<any>>();
const cached = <A extends any[]>(name: string, f: (...a: A) => Promise<any>) => (...a: A) => {
  const key = `${name}:${a.join(",")}`;
  if (!getObserver()) return f(...a);
  if (!cache.has(key)) cache.set(key, f(...a));
  return cache.get(key)!;
};
const fetchIssues = cached("fetchIssues", api.fetchIssues), fetchIssue = cached("fetchIssue", api.fetchIssue);
const search = cached("search", api.search), fetchLabels = cached("fetchLabels", api.fetchLabels);
const guessable = <T,>(init: T) => { const [t] = createSignal<T>((() => init) as any); return createOptimistic<T>(() => t()); };

type Rename = { id: number; title: string };
const titleOf = (rs: Rename[], id: number, t: string) => rs.reduce((x, r) => (r.id === id ? r.title : x), t);

function Related(props: { title: string }) {
  const hits = createMemo(() => search(props.title));
  return <Loading on={props.title} fallback={<p>finding related help</p>}>
    <Errored fallback={<p>related help failed</p>}>
      <Show when={(hits() as any[]).length === 0} fallback={<p>some related help</p>}><p>no related help</p></Show>
    </Errored>
  </Loading>;
}

function Labels(props: { id: number }) {
  const [labels] = createSignal<any>(() => fetchLabels(props.id));
  const [removing, guessRemove] = guessable<string[]>([]);
  const shown = createMemo(() => (labels() as string[]).filter(l => !removing().includes(l)));
  const remove = action(function* (id: number, label: string) {
    try { guessRemove([...removing(), label]); yield removeLabel(id, label); cache.delete(`fetchLabels:${id}`); refresh(labels); } catch {}
  });
  return <Loading on={props.id} fallback={<p>loading labels</p>}>
    <Errored fallback={<p>labels error</p>}>
      <ul><For each={shown()}>{(l: any) => <li><button data-testid="remove-label" onClick={() => remove(props.id, l)}>remove {l}</button></li>}</For></ul>
    </Errored>
  </Loading>;
}

export default function App() {
  const [selected, setSelected] = createSignal<number | null>(null);
  const issues = createMemo(() => fetchIssues("open"));
  const answer = createMemo(() => (selected() != null ? fetchIssue(selected()!) : undefined));
  const detail = createMemo(() => (selected() == null ? null : (answer() as any)));
  const [renames, guessRename] = guessable<Rename[]>([]);
  const [assigns, guessAssign] = guessable<{ id: number; who: string }[]>([]);
  const rows = createMemo(() => (issues() as any[]).map(r => ({ id: r.id, title: titleOf(renames(), r.id, r.title), assignee: assigns().reduce((w, x) => (x.id === r.id ? x.who : w), r.assignee) })));
  const heading = createMemo(() => (detail() == null ? "" : titleOf(renames(), detail().id, detail().title)));
  const [titleInput, setTitleInput] = createSignal("");

  const select = action(function* (id: number) { setSelected(id); });
  const assignTo = action(function* (id: number, who: string) {
    try { guessAssign(xs => [...xs, { id, who }]); yield assign(id, who); cache.delete("fetchIssues:open"); refresh(issues); } catch {}
  });
  const renameTo = action(function* (id: number, title: string) {
    try { guessRename(rs => [...rs, { id, title }]); yield renameIssue(id, title); cache.delete("fetchIssues:open"); cache.delete(`fetchIssue:${id}`); refresh(issues); refresh(answer); refresh(detail); } catch {}
  });

  return <main>
    <div data-testid="list">
      <Loading fallback={<p>loading open issues</p>}>
        <ul><For each={rows()}>{(it: any) => <li>
          <span data-testid="issue" onClick={() => select(it.id)}>#{it.id} {it.title} ({it.assignee ?? "unassigned"})</span>{" "}
          <button data-testid="row-assign" onClick={() => assignTo(it.id, "guest")}>assign to guest</button>
        </li>}</For></ul>
      </Loading>
    </div>
    <div data-testid="detail">
      <Show when={selected() != null} fallback={<p>select an issue</p>}>
        {(_x: any) => [
          <Loading on={selected()} fallback={<p>loading #{latest(selected)}</p>}>
            <h2>#{detail()?.id} {heading()}</h2><p>(title {detail()?.title})</p>
            <Related title={heading()} />
          </Loading>,
          <input data-testid="title-input" value={titleInput()} onInput={e => setTitleInput(e.currentTarget.value)} />,
          <button data-testid="rename" onClick={() => { if (titleInput() !== "") renameTo(selected()!, titleInput()); }}>rename</button>,
          <Labels id={selected()!} />,
        ]}
      </Show>
    </div>
  </main>;
}
