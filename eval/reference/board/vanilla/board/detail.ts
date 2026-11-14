// The detail of one selected card. A new Detail is made for every selection (even of the same card again), so its
// inputs and errors belong to that selection; `signal` ends with it. The page hands it the card as the board shows
// it on every render.
import type { Column } from "../api";
import { button, h, textInput } from "../dom";
import { COLUMN_NAME, countItems, type CachedItem, type ItemRow } from "./model";
import type { BoardPage, Outcome } from "./page";

export type ChecklistState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; items: CachedItem[] };

/** the selected card as the board shows it, and its checklist (`items` as shown, once it has loaded) */
export type DetailView = { id: number; title: string; column: Column; checklist: ChecklistState; items: ItemRow[] | undefined };

export class Detail {
  readonly root = h("div");
  private title = "";
  private itemText = "";
  private renameError: string | null = null;
  private itemError: string | null = null;
  /** what the detail last showed */
  private view: DetailView | null = null;

  private readonly headEl = h("h2");
  private readonly columnEl = h("p");
  private readonly renameErrorEl = h("div");
  private readonly checklistEl = h("div", { testid: "checklist" });
  private readonly itemErrorEl = h("div");
  private readonly titleInput: HTMLInputElement;
  private readonly itemInput: HTMLInputElement;
  private readonly addItemButton: HTMLButtonElement;

  constructor(
    private readonly page: BoardPage,
    readonly id: number,
    private readonly signal: AbortSignal,
  ) {
    this.titleInput = textInput("title-input", "", value => (this.title = value));
    this.titleInput.placeholder = "new title";
    this.itemInput = textInput("item-input", "", value => (this.itemText = value));
    this.itemInput.placeholder = "new item";
    this.addItemButton = button("add-item", "add item", () => this.addItem());
    this.root.append(
      this.headEl,
      this.columnEl,
      h(
        "div",
        null,
        this.titleInput,
        " ",
        button("rename", "rename", () => this.rename()),
        " ",
        button("archive", "archive", () => page.archive(this.id)),
      ),
      this.renameErrorEl,
      this.checklistEl,
      h("div", null, this.itemInput, " ", this.addItemButton),
      this.itemErrorEl,
    );
  }

  /** runs one write of the kind whose error line `set` writes: it clears the line, and a failure fills it */
  private async run(set: (message: string | null) => void, action: () => Promise<Outcome>) {
    set(null);
    const outcome = await action();
    if (outcome !== null && !this.signal.aborted) {
      set(outcome);
      this.page.render();
    }
  }

  private rename() {
    const title = this.title;
    if (title === "") return;
    void this.run(m => (this.renameError = m), () => this.page.rename(this.id, title));
  }

  private toggle(itemId: number, done: boolean) {
    void this.run(m => (this.itemError = m), () => this.page.toggle(this.id, itemId, done));
  }

  private addItem() {
    const text = this.itemText;
    if (text === "" || !this.view?.items) return;
    this.itemText = this.itemInput.value = "";
    void this.run(m => (this.itemError = m), () => this.page.addItem(this.id, text));
  }

  render(view: DetailView) {
    this.view = view;
    this.headEl.textContent = `#${view.id} ${view.title}`;
    this.columnEl.textContent = `in ${COLUMN_NAME[view.column]}`;
    this.renameErrorEl.replaceChildren(this.renameError === null ? "" : h("p", null, `rename error: ${this.renameError}`));
    this.itemErrorEl.replaceChildren(this.itemError === null ? "" : h("p", null, `item error: ${this.itemError}`));
    this.addItemButton.disabled = !view.items;

    const { checklist, items } = view;
    if (items) {
      const { done, total } = countItems(items);
      this.checklistEl.replaceChildren(
        h(
          "ul",
          null,
          ...items.map(r =>
            r.kind === "adding"
              ? h("li", null, h("span", { testid: "item" }, `[ ] ${r.text} (adding…)`))
              : h("li", null, h("span", { testid: "item" }, `[${r.done ? "x" : " "}] ${r.text}`), " ", button("toggle", "toggle", () => this.toggle(r.id, !r.done))),
          ),
        ),
        h("p", { testid: "progress" }, `${done}/${total} done`),
      );
    } else if (checklist.status === "error") this.checklistEl.replaceChildren(h("p", null, `checklist error: ${checklist.message}`));
    else this.checklistEl.replaceChildren(h("p", null, "loading checklist"));
  }
}
