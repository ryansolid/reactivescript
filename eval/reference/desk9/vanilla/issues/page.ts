// The issues page: the current user, the filter, the list with its row actions, and the selected issue's detail.
// Every write starts here, so a write keeps going (and its answer still counts) when the issue is no longer selected;
// all of it ends when the page is left (`signal`).
import * as api from "../api";
import type { Comment, Issue } from "../api";
import { button, errorMessage, h, latest, textInput } from "../dom";
import { Clock } from "../register";
import { Detail } from "./detail";
import { IssueFacts } from "./facts";
import { ActionError, type Outcome } from "./outcome";

type Filter = "open" | "closed";
type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; issues: Issue[] };

/** a comment on its way to the server */
export type Post = { seq: number; issueId: number; author: string; text: string };
/** a label change on its way to the server */
export type LabelChange = { seq: number; issueId: number; kind: "add" | "remove"; label: string };

export type IssuesHost = {
  /** the open list shows `n` settled rows */
  onOpenCount(n: number): void;
  /** open the help page on `query` with hit `id` selected */
  openHelp(query: string, id: number): void;
};

export class IssuesPage {
  readonly root: HTMLElement;
  readonly facts = new IssueFacts(new Clock());
  private user = "guest";
  private filter: Filter = "open";
  private list: ListState = { status: "loading" };
  private readonly nextListLoad: () => AbortSignal;
  private readonly nextSelection: () => AbortSignal;
  private detail: Detail | null = null;
  private posts: Post[] = [];
  private labelChanges: LabelChange[] = [];
  /** the row actions' error line */
  private readonly rowError: ActionError;

  private readonly listEl = h("div", { testid: "list" });
  private readonly rowErrorEl = h("div");
  private readonly detailEl = h("section", { testid: "detail" }, h("p", null, "select an issue"));
  private readonly filterButtons: Record<Filter, HTMLButtonElement>;

  constructor(
    private readonly signal: AbortSignal,
    private readonly host: IssuesHost,
  ) {
    this.rowError = new ActionError(signal, () => this.render());
    this.nextListLoad = latest(signal);
    this.nextSelection = latest(signal);
    this.filterButtons = {
      open: button("filter-open", "open", () => this.setFilter("open")),
      closed: button("filter-closed", "closed", () => this.setFilter("closed")),
    };
    const userInput = textInput("user", this.user, value => {
      this.user = value;
      this.render();
    });
    this.root = h(
      "main",
      { className: "issues" },
      h(
        "section",
        { className: "issue-list" },
        h("label", null, "user ", userInput),
        h("div", { className: "filters" }, this.filterButtons.open, " ", this.filterButtons.closed),
        this.listEl,
        this.rowErrorEl,
      ),
      this.detailEl,
    );
    void this.loadList();
    this.render();
  }

  currentUser() {
    return this.user;
  }

  private setFilter(filter: Filter) {
    if (filter === this.filter) return;
    this.filter = filter;
    void this.loadList();
    this.render();
  }

  private async loadList() {
    const signal = this.nextListLoad();
    const filter = this.filter;
    const askedAt = this.facts.clock.tick();
    this.list = { status: "loading" };
    try {
      const issues = await api.fetchIssues(filter);
      if (signal.aborted) return;
      this.facts.learnList(filter, issues, askedAt);
      this.list = { status: "ok", issues };
    } catch (e) {
      if (signal.aborted) return;
      this.list = { status: "error", message: errorMessage(e) };
    }
    this.render();
  }

  private select(id: number) {
    this.detail = new Detail(this, id, this.nextSelection());
    this.detailEl.replaceChildren(this.detail.root);
  }

  // --- writes -------------------------------------------------------------------------------------------------

  /**
   * Runs one write against the server: shows its guess at once, and re-renders when it answers. Once the page is
   * left, its answer changes nothing (the callers' signals have ended too, so they report nothing).
   */
  private async write<T>(request: Promise<T>, accepted: (answer: T) => void, declined: () => void): Promise<Outcome> {
    this.render();
    try {
      const answer = await request;
      if (this.signal.aborted) return null;
      accepted(answer);
      return null;
    } catch (e) {
      if (this.signal.aborted) return null;
      declined();
      return errorMessage(e);
    } finally {
      if (!this.signal.aborted) this.render();
    }
  }

  assign(id: number, user: string): Promise<Outcome> {
    const w = this.facts.of(id).assignee.write(user);
    return this.write(api.assign(id, user), res => w.accepted(res.assignee), w.declined);
  }

  rename(id: number, title: string): Promise<Outcome> {
    const w = this.facts.of(id).title.write(title);
    return this.write(api.renameIssue(id, title), res => w.accepted(res.title), w.declined);
  }

  close(id: number): Promise<Outcome> {
    const w = this.facts.of(id).open.write(false);
    return this.write(api.closeIssue(id), () => w.accepted(false), w.declined);
  }

  postsFor(id: number) {
    return this.posts.filter(p => p.issueId === id);
  }

  post(id: number, author: string, text: string): Promise<Outcome> {
    const seq = this.facts.clock.tick();
    this.posts = [...this.posts, { seq, issueId: id, author, text }];
    const settle = () => {
      this.posts = this.posts.filter(p => p.seq !== seq);
    };
    return this.write(
      api.addComment(id, author, text),
      (comment: Comment) => {
        settle();
        this.detail?.commentAdded(id, comment);
      },
      settle,
    );
  }

  labelChangesFor(id: number) {
    return this.labelChanges.filter(c => c.issueId === id);
  }

  changeLabel(id: number, kind: LabelChange["kind"], label: string): Promise<Outcome> {
    const seq = this.facts.clock.tick();
    this.labelChanges = [...this.labelChanges, { seq, issueId: id, kind, label }];
    const settle = () => {
      this.labelChanges = this.labelChanges.filter(c => c.seq !== seq);
    };
    return this.write(
      kind === "add" ? api.addLabel(id, label) : api.removeLabel(id, label),
      labels => {
        settle();
        this.detail?.labelsAnswered(id, labels);
      },
      settle,
    );
  }

  openHelp(query: string, id: number) {
    this.host.openHelp(query, id);
  }

  // --- rendering ----------------------------------------------------------------------------------------------

  render() {
    for (const f of ["open", "closed"] as const) this.filterButtons[f].setAttribute("aria-pressed", String(f === this.filter));
    this.renderList();
    this.rowErrorEl.replaceChildren(this.rowError.line("row error: ", "row-error"));
    this.detail?.render();
  }

  private renderList() {
    const list = this.list;
    if (list.status === "loading") return this.listEl.replaceChildren(h("p", null, `loading ${this.filter} issues`));
    if (list.status === "error") return this.listEl.replaceChildren(h("p", null, `list error: ${list.message}`));
    const issues = this.filter === "open" ? list.issues.filter(i => this.facts.showsAsOpen(i.id)) : list.issues;
    if (this.filter === "open") this.host.onOpenCount(issues.length);
    this.listEl.replaceChildren(h("ul", null, ...issues.map(issue => this.renderRow(this.facts.row(issue)))));
  }

  private renderRow(issue: Issue) {
    const id = issue.id;
    return h(
      "li",
      null,
      h(
        "button",
        { type: "button", testid: "issue", ariaPressed: String(this.detail?.id === id), onclick: () => this.select(id) },
        `#${id} ${issue.title} (${issue.assignee ?? "unassigned"})`,
      ),
      " ",
      button("row-assign", `assign to ${this.user}`, () => void this.rowError.run(() => this.assign(id, this.user))),
      this.filter === "open" && " ",
      this.filter === "open" && button("row-close", "close", () => void this.rowError.run(() => this.close(id))),
    );
  }
}
