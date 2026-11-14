// The help page: a search over the help catalogue, and the selected hit's item.
import * as api from "./api";
import type { Hit, Item } from "./api";
import { button, errorMessage, h, latest, textInput } from "./dom";

type Results =
  | { status: "none" }
  | { status: "too short" }
  | { status: "searching"; previous: { query: string; hits: Hit[] } | null }
  | { status: "ok"; query: string; hits: Hit[] }
  | { status: "error"; message: string };

type ItemState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; item: Item | null };

/** Opens on `query` with hit `selected` chosen: both empty from the tab, an issue's title and hit from related help. */
export function helpPage(signal: AbortSignal, initial: { query: string; selected: number | null }): HTMLElement {
  let query = initial.query;
  let results: Results = { status: "none" };
  let selected: number | null = null;
  let item: ItemState = { status: "loading" };
  const nextSearch = latest(signal);
  const nextItem = latest(signal);

  const resultsEl = h("section", { testid: "results" });
  const itemEl = h("section", { testid: "item" });

  function setQuery(q: string) {
    query = q;
    const searchSignal = nextSearch();
    if (q === "") results = { status: "none" };
    else if (q.length < 2) results = { status: "too short" };
    else {
      const previous = results.status === "ok" ? { query: results.query, hits: results.hits } : results.status === "searching" ? results.previous : null;
      results = { status: "searching", previous };
      api.search(q).then(
        hits => {
          if (searchSignal.aborted) return;
          results = { status: "ok", query: q, hits };
          renderResults();
        },
        (e: unknown) => {
          if (searchSignal.aborted) return;
          results = { status: "error", message: errorMessage(e) };
          renderResults();
        },
      );
    }
    renderResults();
  }

  function select(id: number) {
    selected = id;
    renderResults();
    loadItem();
  }

  function loadItem() {
    if (selected === null) return;
    const id = selected;
    const itemSignal = nextItem();
    item = { status: "loading" };
    api.fetchItem(id).then(
      answer => {
        if (itemSignal.aborted) return;
        item = { status: "ok", item: answer };
        renderItem();
      },
      (e: unknown) => {
        if (itemSignal.aborted) return;
        item = { status: "error", message: errorMessage(e) };
        renderItem();
      },
    );
    renderItem();
  }

  function hitList(q: string, hits: Hit[]) {
    return h(
      "div",
      null,
      h("h2", null, `${hits.length} results for ${q}`),
      h(
        "ul",
        null,
        ...hits.map(hit => h("li", { testid: "hit", onclick: () => select(hit.id) }, hit.id === selected ? `> ${hit.name}` : hit.name)),
      ),
    );
  }

  function renderResults() {
    const r = results;
    if (r.status === "none") resultsEl.replaceChildren();
    else if (r.status === "too short") resultsEl.replaceChildren(h("p", null, `too short: ${query}`));
    else if (r.status === "searching") resultsEl.replaceChildren(h("p", null, "searching…"), ...(r.previous ? [hitList(r.previous.query, r.previous.hits)] : []));
    else if (r.status === "error") resultsEl.replaceChildren(h("p", null, `search failed: ${r.message}`));
    else resultsEl.replaceChildren(hitList(r.query, r.hits));
  }

  function renderItem() {
    const s = item;
    if (selected === null) itemEl.replaceChildren(h("p", null, "pick a result"));
    else if (s.status === "loading") itemEl.replaceChildren(h("p", null, "loading…"));
    else if (s.status === "error")
      itemEl.replaceChildren(h("p", null, `failed: ${s.message}`), " ", button("retry-item", "retry", loadItem));
    else if (s.item === null) itemEl.replaceChildren(h("p", null, `item ${selected} not found`));
    else itemEl.replaceChildren(h("article", null, h("h3", null, s.item.name), h("p", null, s.item.blurb)));
  }

  const root = h("main", { className: "help" }, textInput("query", query, setQuery), resultsEl, itemEl);
  setQuery(query);
  if (initial.selected !== null) select(initial.selected);
  else renderItem();
  return root;
}
