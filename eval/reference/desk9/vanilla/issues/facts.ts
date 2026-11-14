// What the issues page knows about each issue, gathered from every answer it got (the lists, the details, the
// writes): the list rows and the detail heading read the same facts, so they always agree.
import type { Issue } from "../api";
import { Clock, Register } from "../register";

type Facts = { title: Register<string>; assignee: Register<string | null>; open: Register<boolean> };

export class IssueFacts {
  private readonly byId = new Map<number, Facts>();

  constructor(readonly clock: Clock) {}

  of(id: number): Facts {
    let facts = this.byId.get(id);
    if (!facts) {
      facts = { title: new Register(this.clock), assignee: new Register(this.clock), open: new Register(this.clock) };
      this.byId.set(id, facts);
    }
    return facts;
  }

  /** a list of `filter` issues asked at `askedAt` answered `issues` */
  learnList(filter: "open" | "closed", issues: Issue[], askedAt: number) {
    for (const issue of issues) {
      const f = this.of(issue.id);
      f.title.learn(issue.title, askedAt);
      f.assignee.learn(issue.assignee, askedAt);
      f.open.learn(filter === "open", askedAt);
    }
  }

  /** a list row as it shows now */
  row(issue: Issue): Issue {
    const f = this.of(issue.id);
    return { id: issue.id, title: f.title.shown(issue.title), assignee: f.assignee.shown(issue.assignee) };
  }

  /** whether a row of the open list shows: not while it is being closed or once it was closed */
  showsAsOpen(id: number) {
    return this.of(id).open.shown(true);
  }
}
