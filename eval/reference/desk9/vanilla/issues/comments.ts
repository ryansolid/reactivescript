// The selected issue's comments: as the server answered them, with the posts still on their way after them.
import * as api from "../api";
import type { Comment } from "../api";
import { errorMessage, h } from "../dom";
import type { IssuesPage } from "./page";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; comments: Comment[] };

export class Comments {
  readonly root = h("div", { testid: "comments" });
  private state: State = { status: "loading" };

  constructor(
    private readonly page: IssuesPage,
    private readonly id: number,
    private readonly signal: AbortSignal,
  ) {
    void this.load();
  }

  private async load() {
    try {
      const comments = await api.fetchComments(this.id);
      if (this.signal.aborted) return;
      this.state = { status: "ok", comments };
    } catch (e) {
      if (this.signal.aborted) return;
      this.state = { status: "error", message: errorMessage(e) };
    }
    this.render();
  }

  /** the server took a comment: it joins the list (a load still out answers with it) */
  added(comment: Comment) {
    if (this.state.status === "ok") this.state = { status: "ok", comments: [...this.state.comments, comment] };
  }

  render() {
    const s = this.state;
    if (s.status === "loading") return this.root.replaceChildren(h("p", null, "loading comments"));
    if (s.status === "error") return this.root.replaceChildren(h("p", null, `comments error: ${s.message}`));
    const row = (text: string) => h("li", { testid: "comment" }, text);
    this.root.replaceChildren(
      h(
        "ul",
        null,
        ...s.comments.map(c => row(`${c.author}: ${c.text}`)),
        ...this.page.postsFor(this.id).map(p => row(`${p.author}: ${p.text} (sending…)`)),
      ),
    );
  }
}
