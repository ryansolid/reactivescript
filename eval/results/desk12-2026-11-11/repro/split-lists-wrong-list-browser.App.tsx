import { Loading, For, Errored, action, createMemo, createOptimisticStore, createSignal, refresh, latest } from "solid-js";
import { fetchIssues, assign } from "./api";
const draft = (d: any, v: any[]) => { const rows = v.map(i => ({ id: i.id, title: i.title, assignee: i.assignee, closing: false })); d.length = rows.length; rows.forEach((x, i) => { d[i] = x; }); };
// Two lists, each over a constant question; a filter picks one. A row write on the open list lands and its refresh is
// out when the user switches to closed and back (the switch back re-asks the open list too).
export default function App() {
  const [filter, setFilter] = createSignal("open");
  const aOpen = createMemo(() => fetchIssues("open"));
  const aClosed = createMemo(() => fetchIssues("closed"));
  const [open, setOpen] = createOptimisticStore((d: any) => { draft(d, aOpen() as any); }, [] as any[], { key: "id" } as any);
  const [closed] = createOptimisticStore((d: any) => { draft(d, aClosed() as any); }, [] as any[], { key: "id" } as any);
  const issues = createMemo(() => filter() === "open" ? open : closed);
  const rowAssign = action(function* (id: number) {
    setOpen((d: any) => { d[d.findIndex((r: any) => r.id === id)].assignee = "guest"; });
    yield assign(id, "guest");
    refresh(aOpen); refresh(open);
  });
  return <div>
    <button data-testid="tab-issues">Issues</button>
    <button data-testid="filter-open" onClick={() => { if (filter() !== "open") { setFilter("open"); } }}>open</button>
    <button data-testid="filter-closed" onClick={() => { if (filter() !== "closed") setFilter("closed"); }}>closed</button>
    <div data-testid="list">
      <Loading on={filter()} fallback={<p>loading</p>}>
                  <ul><For each={issues() as any}>{(r: any) => <li><span data-testid="issue">#{r.id} {r.title} ({r.assignee ?? "unassigned"})</span> <button data-testid="row-assign" onClick={() => rowAssign(r.id)}>assign</button></li>}</For></ul>
      </Loading>
    </div>
    <div data-testid="detail"><p>select an issue</p></div>
  </div>;
}
