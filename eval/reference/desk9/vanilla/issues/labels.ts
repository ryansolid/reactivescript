// The selected issue's labels: as the server last answered them, with the changes still on their way laid over them
// in the order they started; and the input that adds one.
import * as api from "../api";
import { button, errorMessage, h, textInput } from "../dom";
import { ActionError } from "./outcome";
import type { IssuesPage, LabelChange } from "./page";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; labels: string[] };

const withChanges = (labels: string[], changes: LabelChange[]) =>
  changes.reduce(
    (ls, c) => (c.kind === "remove" ? ls.filter(l => l !== c.label) : ls.includes(c.label) ? ls : [...ls, c.label]),
    labels,
  );

export class Labels {
  private state: State = { status: "loading" };
  private input = "";
  private readonly error: ActionError;

  private readonly listEl = h("div", { testid: "labels" });
  private readonly inputEl = textInput("label-input", "", value => (this.input = value));
  private readonly errorEl = h("div");
  readonly root = h(
    "div",
    { className: "labels" },
    this.listEl,
    h("div", null, this.inputEl, " ", button("add-label", "add label", () => this.add()), this.errorEl),
  );

  constructor(
    private readonly page: IssuesPage,
    private readonly id: number,
    private readonly signal: AbortSignal,
  ) {
    this.error = new ActionError(signal, () => this.render());
    void this.load();
  }

  private async load() {
    try {
      const labels = await api.fetchLabels(this.id);
      if (this.signal.aborted) return;
      this.state = { status: "ok", labels };
    } catch (e) {
      if (this.signal.aborted) return;
      this.state = { status: "error", message: errorMessage(e) };
    }
    this.render();
  }

  /** the server answered the labels after a change (a load still out answers the same or newer) */
  answered(labels: string[]) {
    if (this.state.status === "ok") this.state = { status: "ok", labels };
  }

  /** the labels as they show now, or null while they are not on screen */
  private shown() {
    return this.state.status === "ok" ? withChanges(this.state.labels, this.page.labelChangesFor(this.id)) : null;
  }

  private add() {
    const label = this.input.trim();
    const shown = this.shown();
    if (label === "" || !shown || shown.includes(label)) return;
    this.input = this.inputEl.value = "";
    void this.error.run(() => this.page.changeLabel(this.id, "add", label));
  }

  private remove(label: string) {
    void this.error.run(() => this.page.changeLabel(this.id, "remove", label));
  }

  render() {
    const s = this.state;
    if (s.status === "loading") this.listEl.replaceChildren(h("p", null, "loading labels"));
    else if (s.status === "error") this.listEl.replaceChildren(h("p", null, `labels error: ${s.message}`));
    else
      this.listEl.replaceChildren(
        h(
          "ul",
          null,
          ...(this.shown() ?? []).map(label =>
            h("li", null, h("span", { testid: "label" }, label), " ", button("remove-label", `remove ${label}`, () => this.remove(label))),
          ),
        ),
      );
    this.errorEl.replaceChildren(this.error.line("label error: "));
  }
}
