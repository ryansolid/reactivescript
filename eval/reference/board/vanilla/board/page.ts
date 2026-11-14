// The board page: three columns, the add-card input under To do, and the selected card's detail. The page keeps the
// server's last answers (the columns, and every checklist it loaded) and the writes still in the air; what shows is
// always the one laid over the other, so the cards, headings, counts and the detail read the same thing. Every write
// starts here, so it keeps going (and its answer still counts) when its card is no longer selected; all of it ends
// when the page is left (`signal`).
import * as api from "../api";
import type { Column } from "../api";
import { button, errorMessage, h, latest, textInput } from "../dom";
import { Detail, type ChecklistState, type DetailView } from "./detail";
import {
  COLUMNS,
  COLUMN_NAME,
  WIP_LIMIT,
  addSlot,
  countItems,
  isColumn,
  layColumns,
  layItems,
  mapColumns,
  newest,
  placeCard,
  type Archiving,
  type CachedItem,
  type CardAdd,
  type Columns,
  type ItemAdd,
  type ItemRow,
  type Move,
  type Rename,
  type Toggle,
} from "./model";

/** `null` when the server took the write, else the server's message */
export type Outcome = string | null;

/** a card as the board shows it, or one being added (no id yet) */
type ShownRow = { kind: "card"; id: number; title: string; done: number; total: number } | { kind: "adding"; seq: number; title: string };

export class BoardPage {
  readonly root: HTMLElement;
  private seq = 0;

  // the server's last answers
  private cols: Columns = { todo: undefined, doing: undefined, done: undefined };
  /** a column's load failure, while it is not being asked again */
  private colErrors: Record<Column, string | null> = { todo: null, doing: null, done: null };
  private readonly nextColumnLoad: Record<Column, () => AbortSignal>;
  /** every checklist the page loaded stays for its life, so a card whose checklist is known counts it as shown */
  private readonly checklists = new Map<number, ChecklistState>();

  // writes in the air
  private moves: Move[] = [];
  private adds: CardAdd[] = [];
  private archiving: Archiving[] = [];
  private renames: Rename[] = [];
  private toggles: Toggle[] = [];
  private itemAdds: ItemAdd[] = [];

  private moveError: string | null = null;
  private addError: string | null = null;
  private archiveError: string | null = null;

  private detail: { view: Detail; end: AbortController } | null = null;
  private newCard = "";

  private readonly colEls: Record<Column, { head: HTMLElement; body: HTMLElement }>;
  private readonly newCardInput: HTMLInputElement;
  private readonly addCardButton: HTMLButtonElement;
  private readonly addErrorEl = h("div");
  private readonly detailEl = h("section", { testid: "detail", className: "detail" });
  private readonly errorsEl = h("div");

  constructor(private readonly signal: AbortSignal) {
    this.nextColumnLoad = { todo: latest(signal), doing: latest(signal), done: latest(signal) };
    this.newCardInput = textInput("new-card", "", value => (this.newCard = value));
    this.newCardInput.placeholder = "new card";
    this.addCardButton = button("add-card", "add", () => this.add());
    const section = (c: Column) => {
      const head = h("h2", { testid: `head-${c}` });
      const body = h("div");
      return { head, body };
    };
    this.colEls = { todo: section("todo"), doing: section("doing"), done: section("done") };
    const column = (c: Column, ...footer: HTMLElement[]) =>
      h("section", { testid: `col-${c}`, className: "column" }, this.colEls[c].head, this.colEls[c].body, ...footer);
    this.root = h(
      "main",
      { className: "board" },
      h(
        "div",
        { className: "lanes" },
        column("todo", h("div", null, this.newCardInput, " ", this.addCardButton, this.addErrorEl)),
        column("doing"),
        column("done"),
        this.detailEl,
      ),
      this.errorsEl,
    );
    for (const c of COLUMNS) void this.loadColumn(c);
    this.render();
  }

  private nextSeq() {
    return ++this.seq;
  }

  // --- loads --------------------------------------------------------------------------------------------------

  private async loadColumn(c: Column) {
    const signal = this.nextColumnLoad[c]();
    this.colErrors[c] = null;
    this.render();
    try {
      const cards = await api.fetchCards(c);
      if (signal.aborted) return;
      this.cols = { ...this.cols, [c]: cards };
    } catch (e) {
      if (signal.aborted) return;
      this.colErrors[c] = errorMessage(e);
    }
    this.render();
  }

  /** loads card `id`'s checklist unless the page already has it or is getting it */
  private async loadChecklist(id: number) {
    const known = this.checklists.get(id);
    if (known && known.status !== "error") return;
    this.checklists.set(id, { status: "loading" });
    try {
      const items = await api.fetchChecklist(id);
      if (this.signal.aborted) return;
      this.checklists.set(id, { status: "ok", items });
    } catch (e) {
      if (this.signal.aborted) return;
      this.checklists.set(id, { status: "error", message: errorMessage(e) });
    }
    this.render();
  }

  // --- writes -------------------------------------------------------------------------------------------------

  /**
   * Runs one write: its guess is already in the air (and shows at once); `settle` takes it out when the server
   * answers, and `accepted` writes the answer into the caches. Once the page is left, its answer changes nothing.
   */
  private async write<T>(request: () => Promise<T>, settle: () => void, accepted: (answer: T) => void): Promise<Outcome> {
    this.render();
    try {
      const answer = await request();
      if (this.signal.aborted) return null;
      settle();
      accepted(answer);
      return null;
    } catch (e) {
      if (this.signal.aborted) return null;
      settle();
      return errorMessage(e);
    } finally {
      if (!this.signal.aborted) this.render();
    }
  }

  private async move(id: number, column: Column, index: number) {
    const seq = this.nextSeq();
    this.moveError = null;
    this.moves = [...this.moves, { seq, id, column, index }];
    const outcome = await this.write(
      () => api.moveCard(id, column, index),
      () => (this.moves = this.moves.filter(m => m.seq !== seq)),
      res => (this.cols = placeCard(this.cols, res.id, isColumn(res.column) ? res.column : column, res.index)),
    );
    if (outcome !== null) this.showError(() => (this.moveError = outcome));
  }

  private add() {
    const title = this.newCard;
    if (title === "" || this.cols.todo === undefined) return;
    this.newCard = this.newCardInput.value = "";
    const seq = this.nextSeq();
    this.addError = null;
    this.adds = [...this.adds, { seq, title }];
    void this.write(
      () => api.addCard("todo", title),
      () => (this.adds = this.adds.filter(a => a.seq !== seq)),
      res => {
        const todo = this.cols.todo;
        if (!todo || todo.some(x => x.id === res.id)) return;
        const next = [...todo];
        next.splice(addSlot(todo, seq, x => x.addSeq), 0, { id: res.id, title: res.title, done: 0, total: 0, addSeq: seq });
        this.cols = { ...this.cols, todo: next };
      },
    ).then(outcome => {
      if (outcome !== null) this.showError(() => (this.addError = outcome));
    });
  }

  private showError(set: () => void) {
    if (this.signal.aborted) return;
    set();
    this.render();
  }

  rename(id: number, title: string): Promise<Outcome> {
    const seq = this.nextSeq();
    this.renames = [...this.renames, { seq, id, title }];
    return this.write(
      () => api.renameCard(id, title),
      () => (this.renames = this.renames.filter(n => n.seq !== seq)),
      res => (this.cols = mapColumns(this.cols, cards => cards.map(x => (x.id === res.id ? { ...x, title: res.title } : x)))),
    );
  }

  archive(id: number) {
    const seq = this.nextSeq();
    this.archiveError = null;
    this.deselect();
    this.archiving = [...this.archiving, { seq, id }];
    void this.write(
      () => api.archiveCard(id),
      () => (this.archiving = this.archiving.filter(a => a.seq !== seq)),
      res => (this.cols = mapColumns(this.cols, cards => cards.filter(x => x.id !== res.id))),
    ).then(outcome => {
      if (outcome !== null) this.showError(() => (this.archiveError = outcome));
    });
  }

  /** patches card `cardId`'s loaded checklist with `f` */
  private patchChecklist(cardId: number, f: (items: CachedItem[]) => CachedItem[]) {
    const list = this.checklists.get(cardId);
    if (list?.status === "ok") this.checklists.set(cardId, { status: "ok", items: f(list.items) });
  }

  toggle(cardId: number, itemId: number, done: boolean): Promise<Outcome> {
    const seq = this.nextSeq();
    this.toggles = [...this.toggles, { seq, cardId, itemId, done }];
    return this.write(
      () => api.toggleItem(cardId, itemId, done),
      () => (this.toggles = this.toggles.filter(t => t.seq !== seq)),
      res => this.patchChecklist(cardId, items => items.map(i => (i.id === res.id ? { ...i, done: res.done } : i))),
    );
  }

  addItem(cardId: number, text: string): Promise<Outcome> {
    const seq = this.nextSeq();
    this.itemAdds = [...this.itemAdds, { seq, cardId, text }];
    return this.write(
      () => api.addItem(cardId, text),
      () => (this.itemAdds = this.itemAdds.filter(a => a.seq !== seq)),
      res =>
        this.patchChecklist(cardId, items => {
          if (items.some(i => i.id === res.id)) return items;
          const next = [...items];
          next.splice(addSlot(items, seq, i => i.addSeq), 0, { ...res, addSeq: seq });
          return next;
        }),
    );
  }

  // --- selection ----------------------------------------------------------------------------------------------

  private select(id: number) {
    this.detail?.end.abort();
    const end = new AbortController();
    const signal = AbortSignal.any([this.signal, end.signal]);
    this.detail = { view: new Detail(this, id, signal), end };
    void this.loadChecklist(id);
    this.render();
  }

  private deselect() {
    this.detail?.end.abort();
    this.detail = null;
  }

  // --- what shows ---------------------------------------------------------------------------------------------

  /** card `id`'s checklist as shown, writes in the air included; undefined until it has loaded */
  private itemsOf(id: number): ItemRow[] | undefined {
    const list = this.checklists.get(id);
    if (list?.status !== "ok") return undefined;
    return layItems(
      list.items,
      this.toggles.filter(t => t.cardId === id),
      this.itemAdds.filter(a => a.cardId === id),
    );
  }

  private shown(): Record<Column, ShownRow[] | undefined> {
    const laid = layColumns(this.cols, this.moves, this.adds, this.archiving);
    const shown = {} as Record<Column, ShownRow[] | undefined>;
    for (const c of COLUMNS)
      shown[c] = laid[c]?.map(r => {
        if (r.kind === "adding") return r;
        const items = this.itemsOf(r.card.id);
        const { done, total } = items ? countItems(items) : r.card;
        const title = newest(this.renames, n => n.id === r.card.id)?.title ?? r.card.title;
        return { kind: "card", id: r.card.id, title, done, total };
      });
    return shown;
  }

  render() {
    if (this.signal.aborted) return;
    const shown = this.shown();
    /** whether a card may move into `target` from another column: it has loaded, and Doing is under its limit */
    const canEnter = (target: Column) => {
      const rows = shown[target];
      return rows !== undefined && (target !== "doing" || rows.length < WIP_LIMIT);
    };
    const selected = this.detail?.view.id ?? null;

    for (const [at, c] of COLUMNS.entries()) {
      const rows = shown[c];
      const { head, body } = this.colEls[c];
      head.textContent = `${COLUMN_NAME[c]}${rows ? ` (${rows.length})` : ""}`;
      const error = this.colErrors[c];
      if (rows) {
        const left = COLUMNS[at - 1] as Column | undefined;
        const right = COLUMNS[at + 1] as Column | undefined;
        const across = (dir: "left" | "right", target: Column | undefined, id: number) => {
          if (!target) return null;
          const b = button(dir, dir, () => void this.move(id, target, shown[target]?.length ?? 0));
          b.disabled = !canEnter(target);
          return b;
        };
        body.replaceChildren(
          h(
            "ul",
            null,
            ...rows.map((r, i) => {
              if (r.kind === "adding") return h("li", null, h("span", { testid: "card" }, `${r.title} (adding…)`));
              const card = h("button", { type: "button", testid: "card", onclick: () => this.select(r.id) }, `#${r.id} ${r.title} · ${r.done}/${r.total}`);
              card.setAttribute("aria-pressed", String(r.id === selected));
              return h(
                "li",
                null,
                card,
                " ",
                across("left", left, r.id),
                across("right", right, r.id),
                i > 0 && button("up", "up", () => void this.move(r.id, c, i - 1)),
                i < rows.length - 1 && button("down", "down", () => void this.move(r.id, c, i + 1)),
              );
            }),
          ),
        );
      } else if (error !== null)
        body.replaceChildren(h("p", null, `error: ${error} `, button(`retry-${c}`, "retry", () => void this.loadColumn(c))));
      else body.replaceChildren(h("p", null, "loading"));
    }
    this.addCardButton.disabled = shown.todo === undefined;
    this.addErrorEl.replaceChildren(this.addError === null ? "" : h("p", { testid: "add-error" }, `add error: ${this.addError}`));

    // the selected card as the board shows it
    let view: DetailView | null = null;
    for (const c of COLUMNS)
      for (const r of shown[c] ?? [])
        if (r.kind === "card" && r.id === selected)
          view = { id: r.id, title: r.title, column: c, checklist: this.checklists.get(r.id) ?? { status: "loading" }, items: this.itemsOf(r.id) };
    if (this.detail && view) {
      this.detail.view.render(view);
      this.detailEl.replaceChildren(this.detail.view.root);
    } else this.detailEl.replaceChildren(h("p", null, "select a card"));

    this.errorsEl.replaceChildren(
      this.moveError === null ? "" : h("p", { testid: "move-error" }, `move error: ${this.moveError}`),
      this.archiveError === null ? "" : h("p", { testid: "archive-error" }, `archive error: ${this.archiveError}`),
    );
  }
}
