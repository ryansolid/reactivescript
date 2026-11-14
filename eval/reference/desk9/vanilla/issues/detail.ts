// The detail of one selected issue. A new Detail is made for every selection (even of the same issue again), so its
// inputs, errors and loads belong to that selection; `signal` ends with it.
import * as api from "../api";
import type { Comment, IssueDetail } from "../api";
import { button, errorMessage, h, latest, textInput } from "../dom";
import { Comments } from "./comments";
import { Labels } from "./labels";
import { ActionError } from "./outcome";
import type { IssuesPage } from "./page";
import { Related } from "./related";

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; detail: IssueDetail; related: Related };

export class Detail {
  readonly root = h("div");
  private state: DetailState = { status: "loading" };
  private readonly nextLoad: () => AbortSignal;
  private readonly comments: Comments;
  private readonly labels: Labels;
  private readonly errors: Record<"assign" | "rename" | "close" | "post", ActionError>;
  private title = "";
  private commentText = "";

  private readonly bodyEl = h("div");
  private readonly assignButton: HTMLButtonElement;
  private readonly errorEls = { assign: h("div"), rename: h("div"), close: h("div"), post: h("div") };
  private readonly titleInput: HTMLInputElement;
  private readonly commentInput: HTMLInputElement;

  constructor(
    private readonly page: IssuesPage,
    readonly id: number,
    private readonly signal: AbortSignal,
  ) {
    const render = () => this.render();
    this.nextLoad = latest(signal);
    this.errors = {
      assign: new ActionError(signal, render),
      rename: new ActionError(signal, render),
      close: new ActionError(signal, render),
      post: new ActionError(signal, render),
    };
    this.comments = new Comments(page, id, signal);
    this.labels = new Labels(page, id, signal);
    this.assignButton = button("assign", "", () => this.assign());
    this.titleInput = textInput("title-input", "", value => (this.title = value));
    this.commentInput = textInput("comment-input", "", value => (this.commentText = value));

    this.root.append(
      this.bodyEl,
      h(
        "div",
        { className: "actions" },
        button("retry", "retry", () => void this.load()),
        " ",
        this.assignButton,
        this.errorEls.assign,
      ),
      h("div", null, this.titleInput, " ", button("rename", "rename", () => this.rename()), this.errorEls.rename),
      h("div", null, button("close", "close", () => this.close()), this.errorEls.close),
      this.labels.root,
      this.comments.root,
      h("div", null, this.commentInput, " ", button("post", "post", () => this.post()), this.errorEls.post),
    );
    void this.load();
    this.render();
  }

  private async load() {
    const signal = this.nextLoad();
    const askedAt = this.page.facts.clock.tick();
    this.state = { status: "loading" };
    this.render();
    try {
      const detail = await api.fetchIssue(this.id);
      if (signal.aborted) return;
      if (detail === null) {
        this.state = { status: "error", message: `issue #${this.id} not found` };
      } else {
        this.page.facts.of(detail.id).title.learn(detail.title, askedAt);
        const title = this.page.facts.of(detail.id).title.shown(detail.title);
        this.state = { status: "ok", detail, related: new Related(title, signal, (q, hit) => this.page.openHelp(q, hit)) };
      }
    } catch (e) {
      if (signal.aborted) return;
      this.state = { status: "error", message: errorMessage(e) };
    }
    this.render();
  }

  private assign() {
    const user = this.page.currentUser();
    void this.errors.assign.run(() => this.page.assign(this.id, user));
  }

  private rename() {
    const title = this.title.trim();
    if (title === "") return;
    void this.errors.rename.run(() => this.page.rename(this.id, title));
  }

  private close() {
    void this.errors.close.run(() => this.page.close(this.id));
  }

  private post() {
    const text = this.commentText.trim();
    if (text === "") return;
    this.commentText = this.commentInput.value = "";
    const author = this.page.currentUser();
    void this.errors.post.run(() => this.page.post(this.id, author, text));
  }

  /** a comment on issue `id` was accepted */
  commentAdded(id: number, comment: Comment) {
    if (id === this.id) this.comments.added(comment);
  }

  /** the server answered issue `id`'s labels after a change */
  labelsAnswered(id: number, labels: string[]) {
    if (id === this.id) this.labels.answered(labels);
  }

  render() {
    if (this.signal.aborted) return;
    const s = this.state;
    if (s.status === "loading") this.bodyEl.replaceChildren(h("p", null, `loading #${this.id}`));
    else if (s.status === "error") this.bodyEl.replaceChildren(h("p", null, `detail error: ${s.message}`));
    else {
      const title = this.page.facts.of(this.id).title.shown(s.detail.title);
      this.bodyEl.replaceChildren(h("h2", null, `#${this.id} ${title}`), h("p", null, s.detail.body), s.related.root);
    }
    this.assignButton.textContent = `assign to ${this.page.currentUser()}`;
    this.errorEls.assign.replaceChildren(this.errors.assign.line(""));
    this.errorEls.rename.replaceChildren(this.errors.rename.line("rename error: "));
    this.errorEls.close.replaceChildren(this.errors.close.line("close error: "));
    this.errorEls.post.replaceChildren(this.errors.post.line("post error: "));
    this.labels.render();
    this.comments.render();
  }
}
