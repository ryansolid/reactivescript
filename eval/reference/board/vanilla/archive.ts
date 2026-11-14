// The archive page: the archived cards, and restoring them. Leaving the page ends `signal`.
import * as api from "./api";
import type { Archived } from "./api";
import { button, errorMessage, h } from "./dom";

type ListState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; cards: Archived[] };

export function archivePage(signal: AbortSignal): HTMLElement {
  let list: ListState = { status: "loading" };
  // restores in the air, each with its own seq so that two restores of one row settle separately
  let restoring: { seq: number; id: number }[] = [];
  let restoreError: string | null = null;
  let seq = 0;

  const listEl = h("div", { testid: "archived" });
  const errorEl = h("div");

  async function load() {
    try {
      const cards = await api.fetchArchived();
      if (signal.aborted) return;
      list = { status: "ok", cards };
    } catch (e) {
      if (signal.aborted) return;
      list = { status: "error", message: errorMessage(e) };
    }
    render();
  }

  async function restore(id: number) {
    const mine = ++seq;
    restoreError = null;
    restoring = [...restoring, { seq: mine, id }];
    render();
    try {
      await api.restoreCard(id);
      if (signal.aborted) return;
      if (list.status === "ok") list = { status: "ok", cards: list.cards.filter(c => c.id !== id) };
    } catch (e) {
      if (signal.aborted) return;
      restoreError = errorMessage(e);
    }
    restoring = restoring.filter(r => r.seq !== mine);
    render();
  }

  function render() {
    const s = list;
    if (s.status === "loading") listEl.replaceChildren(h("p", null, "loading archive"));
    else if (s.status === "error") listEl.replaceChildren(h("p", null, `archive error: ${s.message}`));
    else
      listEl.replaceChildren(
        h(
          "ul",
          null,
          ...s.cards
            .filter(c => !restoring.some(r => r.id === c.id))
            .map(c => h("li", null, h("span", { testid: "archived-card" }, `#${c.id} ${c.title}`), " ", button("restore", "restore", () => void restore(c.id)))),
        ),
      );
    errorEl.replaceChildren(restoreError === null ? "" : h("p", { testid: "restore-error" }, `restore error: ${restoreError}`));
  }

  void load();
  render();
  return h("main", { className: "archive" }, listEl, errorEl);
}
