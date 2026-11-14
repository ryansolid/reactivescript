// Related help: the first hits of a help search for the issue's title. Opening a hit hands the title and the hit to
// the help page.
import * as api from "../api";
import { errorMessage, h } from "../dom";

export class Related {
  readonly root = h("div", { testid: "related" }, h("p", null, "finding related help"));

  constructor(
    private readonly title: string,
    private readonly signal: AbortSignal,
    private readonly open: (query: string, id: number) => void,
  ) {
    void this.load();
  }

  private async load() {
    try {
      const hits = await api.search(this.title);
      if (this.signal.aborted) return;
      if (hits.length === 0) return this.root.replaceChildren(h("p", null, "no related help"));
      this.root.replaceChildren(
        h(
          "ul",
          null,
          ...hits.slice(0, 3).map(hit =>
            h("li", null, h("button", { type: "button", testid: "related-hit", onclick: () => this.open(this.title, hit.id) }, hit.name)),
          ),
        ),
      );
    } catch (e) {
      if (this.signal.aborted) return;
      this.root.replaceChildren(h("p", null, `related help failed: ${errorMessage(e)}`));
    }
  }
}
