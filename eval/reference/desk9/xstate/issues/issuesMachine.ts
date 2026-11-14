import { assign, enqueueActions, fromPromise, setup, stopChild, type SnapshotFrom } from "xstate";
import * as api from "../api";
import type { Comment, Hit, Issue, IssueDetail } from "../api";
import { errorMessage, mutation, type MutationEvent } from "../mutation";

export type Filter = "open" | "closed";
/** Where a write was started: the detail's buttons or a list row's. Each place reports its own failures. */
export type Origin = "detail" | "row";

export type WriteRequest =
  | { kind: "assign"; issueId: number; user: string }
  | { kind: "rename"; issueId: number; title: string }
  | { kind: "close"; issueId: number }
  | { kind: "post"; issueId: number; author: string; text: string }
  | { kind: "addLabel"; issueId: number; label: string }
  | { kind: "removeLabel"; issueId: number; label: string };

/** A write in flight. `seq` orders all writes by when they started; `visit` is the selection it was started in. */
export type Write = WriteRequest & { seq: number; visit: number; origin: Origin };

/** What the server answered a write, in the terms the page needs. */
type Outcome =
  | { kind: "assigned"; assignee: string }
  | { kind: "renamed"; title: string }
  | { kind: "closed" }
  | { kind: "posted"; comment: Comment }
  | { kind: "labels"; labels: string[] };

async function perform(w: Write): Promise<Outcome> {
  switch (w.kind) {
    case "assign":
      return { kind: "assigned", assignee: (await api.assign(w.issueId, w.user)).assignee };
    case "rename":
      return { kind: "renamed", title: (await api.renameIssue(w.issueId, w.title)).title };
    case "close":
      await api.closeIssue(w.issueId);
      return { kind: "closed" };
    case "post":
      return { kind: "posted", comment: await api.addComment(w.issueId, w.author, w.text) };
    case "addLabel":
      return { kind: "labels", labels: await api.addLabel(w.issueId, w.label) };
    case "removeLabel":
      return { kind: "labels", labels: await api.removeLabel(w.issueId, w.label) };
  }
}

/** Each kind of failure has one place on screen; the row buttons share one. */
export type Channel = "assign" | "rename" | "close" | "post" | "label" | "row";
const DETAIL_CHANNELS = ["assign", "rename", "close", "post", "label"] as const;
const channelOf = (w: Write): Channel =>
  w.origin === "row" ? "row" : w.kind === "addLabel" || w.kind === "removeLabel" ? "label" : w.kind;

type Field = "title" | "assignee";
const fieldKey = (issueId: number, field: Field) => `${issueId}:${field}`;
const writeId = (seq: number) => `write-${seq}`;

export type IssuesContext = {
  user: string;
  filter: Filter;
  /** the ids of the list's issues, in the server's order, for `filter` */
  rows: number[];
  listError: string;
  /** each issue's title and assignee as the server last answered them */
  server: { title: Record<number, string>; assignee: Record<number, string | null> };
  selected: number | null;
  /** counts selections: the detail's errors belong to the selection they happened in */
  visit: number;
  detail: IssueDetail | null;
  detailError: string;
  /** the selected issue's comments and labels as the server last answered them; null until they load */
  comments: Comment[] | null;
  commentsError: string;
  labels: string[] | null;
  labelsError: string;
  related: { query: string; hits: Hit[] } | null;
  relatedError: string;
  titleInput: string;
  commentInput: string;
  labelInput: string;
  seq: number;
  /** the writes in flight, oldest first */
  writes: Write[];
  /** per issue field, the seq of the newest write the server accepted: an older write's answer must not replace it */
  confirmed: Record<string, number>;
  /** per channel, the newest write started: only it reports its failure */
  latest: Partial<Record<Channel, number>>;
  errors: Partial<Record<Channel, string>>;
};

export type IssuesEvent =
  | { type: "user.change"; value: string }
  | { type: "filter.set"; filter: Filter }
  | { type: "issue.select"; id: number }
  | { type: "detail.retry" }
  | { type: "assign"; issueId: number; origin: Origin }
  | { type: "close"; issueId: number; origin: Origin }
  | { type: "title.change"; value: string }
  | { type: "rename" }
  | { type: "comment.change"; value: string }
  | { type: "post" }
  | { type: "label.change"; value: string }
  | { type: "label.add" }
  | { type: "label.remove"; label: string }
  | MutationEvent<Write, Outcome>;

// --- what the page shows: the server's answers with the writes in flight laid over them ---

/** the value of the newest write in flight to `field`, unless the server already accepted a newer one */
function guess(ctx: IssuesContext, issueId: number, field: Field): string | undefined {
  const floor = ctx.confirmed[fieldKey(issueId, field)] ?? 0;
  for (let i = ctx.writes.length - 1; i >= 0; i--) {
    const w = ctx.writes[i];
    if (w.issueId !== issueId || w.seq <= floor) continue;
    if (field === "title" && w.kind === "rename") return w.title;
    if (field === "assignee" && w.kind === "assign") return w.user;
  }
  return undefined;
}

export const shownTitle = (ctx: IssuesContext, id: number) => guess(ctx, id, "title") ?? ctx.server.title[id] ?? "";
export const shownAssignee = (ctx: IssuesContext, id: number) => guess(ctx, id, "assignee") ?? ctx.server.assignee[id] ?? null;

/** the list's rows: issues being closed are out of the open list until the server declines */
export function shownRows(ctx: IssuesContext): Issue[] {
  const closing = new Set(ctx.writes.filter(w => w.kind === "close").map(w => w.issueId));
  return ctx.rows
    .filter(id => !(ctx.filter === "open" && closing.has(id)))
    .map(id => ({ id, title: shownTitle(ctx, id), assignee: shownAssignee(ctx, id) }));
}

/** the selected issue's labels, with the label changes in flight applied in the order they started */
export function shownLabels(ctx: IssuesContext): string[] | null {
  if (!ctx.labels) return null;
  return ctx.writes.reduce<string[]>((labels, w) => {
    if (w.issueId !== ctx.selected) return labels;
    if (w.kind === "addLabel") return labels.includes(w.label) ? labels : [...labels, w.label];
    if (w.kind === "removeLabel") return labels.filter(l => l !== w.label);
    return labels;
  }, ctx.labels);
}

/** the comments in flight on the selected issue, oldest first */
export const sendingComments = (ctx: IssuesContext) =>
  ctx.writes.filter((w): w is Write & { kind: "post" } => w.kind === "post" && w.issueId === ctx.selected);

// --- applying the server's answers ---

function accepted(ctx: IssuesContext, w: Write, outcome: Outcome): Partial<IssuesContext> {
  const confirm = (field: Field, value: string): Partial<IssuesContext> => {
    const key = fieldKey(w.issueId, field);
    if ((ctx.confirmed[key] ?? 0) > w.seq) return {};
    return {
      confirmed: { ...ctx.confirmed, [key]: w.seq },
      server: { ...ctx.server, [field]: { ...ctx.server[field], [w.issueId]: value } },
    };
  };
  switch (outcome.kind) {
    case "assigned":
      return confirm("assignee", outcome.assignee);
    case "renamed":
      return confirm("title", outcome.title);
    case "closed":
      return ctx.filter === "open" ? { rows: ctx.rows.filter(id => id !== w.issueId) } : {};
    case "posted":
      // comments still loading will answer with the new one in them
      return ctx.comments && ctx.selected === w.issueId ? { comments: [...ctx.comments, outcome.comment] } : {};
    case "labels":
      return ctx.labels && ctx.selected === w.issueId ? { labels: outcome.labels } : {};
  }
}

function declined(ctx: IssuesContext, w: Write, message: string): Partial<IssuesContext> {
  const channel = channelOf(w);
  // a newer write of the same kind took over the error line, and a selection that was left takes its errors along
  const reports = ctx.latest[channel] === w.seq && (w.origin === "row" || w.visit === ctx.visit);
  return reports ? { errors: { ...ctx.errors, [channel]: message } } : {};
}

const withoutWrite = (ctx: IssuesContext, w: Write) => ctx.writes.filter(x => x.seq !== w.seq);

export const issuesMachine = setup({
  types: { context: {} as IssuesContext, events: {} as IssuesEvent },
  actors: {
    fetchIssues: fromPromise(({ input }: { input: Filter }) => api.fetchIssues(input)),
    fetchIssue: fromPromise(({ input }: { input: number }) => api.fetchIssue(input)),
    fetchComments: fromPromise(({ input }: { input: number }) => api.fetchComments(input)),
    fetchLabels: fromPromise(({ input }: { input: number }) => api.fetchLabels(input)),
    searchHelp: fromPromise(({ input }: { input: string }) => api.search(input)),
    write: mutation(perform),
  },
  actions: {
    /** start a write: it shows at once, clears its channel's error, and goes to the server */
    startWrite: enqueueActions(({ context, enqueue }, params: { request: WriteRequest; origin: Origin }) => {
      const seq = context.seq + 1;
      const write: Write = { ...params.request, seq, visit: context.visit, origin: params.origin };
      const channel = channelOf(write);
      enqueue.assign({
        seq,
        writes: [...context.writes, write],
        latest: { ...context.latest, [channel]: seq },
        errors: { ...context.errors, [channel]: undefined },
      });
      enqueue.spawnChild("write", { id: writeId(seq), input: write });
    }),
  },
  guards: {
    otherFilter: ({ context, event }) => event.type === "filter.set" && event.filter !== context.filter,
    titleTyped: ({ context }) => context.titleInput !== "",
    commentTyped: ({ context }) => context.commentInput !== "",
    newLabelTyped: ({ context }) => {
      const labels = shownLabels(context);
      return context.labelInput !== "" && labels !== null && !labels.includes(context.labelInput);
    },
  },
}).createMachine({
  id: "issues",
  type: "parallel",
  context: {
    user: "guest",
    filter: "open",
    rows: [],
    listError: "",
    server: { title: {}, assignee: {} },
    selected: null,
    visit: 0,
    detail: null,
    detailError: "",
    comments: null,
    commentsError: "",
    labels: null,
    labelsError: "",
    related: null,
    relatedError: "",
    titleInput: "",
    commentInput: "",
    labelInput: "",
    seq: 0,
    writes: [],
    confirmed: {},
    latest: {},
    errors: {},
  },
  on: {
    "user.change": { actions: assign({ user: ({ event }) => event.value }) },
    "title.change": { actions: assign({ titleInput: ({ event }) => event.value }) },
    "comment.change": { actions: assign({ commentInput: ({ event }) => event.value }) },
    "label.change": { actions: assign({ labelInput: ({ event }) => event.value }) },
    assign: {
      actions: {
        type: "startWrite",
        params: ({ context, event }) => ({
          request: { kind: "assign", issueId: event.issueId, user: context.user },
          origin: event.origin,
        }),
      },
    },
    close: {
      actions: {
        type: "startWrite",
        params: ({ event }) => ({ request: { kind: "close", issueId: event.issueId }, origin: event.origin }),
      },
    },
    "mutation.succeeded": {
      actions: [
        assign(({ context, event }) => ({
          ...accepted(context, event.input, event.output),
          writes: withoutWrite(context, event.input),
        })),
        stopChild(({ event }) => writeId(event.input.seq)),
      ],
    },
    "mutation.failed": {
      actions: [
        assign(({ context, event }) => ({
          ...declined(context, event.input, event.message),
          writes: withoutWrite(context, event.input),
        })),
        stopChild(({ event }) => writeId(event.input.seq)),
      ],
    },
  },
  states: {
    list: {
      initial: "loading",
      on: {
        "filter.set": {
          guard: "otherFilter",
          target: ".loading",
          actions: assign({ filter: ({ event }) => event.filter }),
        },
      },
      states: {
        loading: {
          invoke: {
            src: "fetchIssues",
            input: ({ context }) => context.filter,
            onDone: {
              target: "loaded",
              actions: assign(({ context, event }) => ({
                rows: event.output.map(i => i.id),
                server: {
                  title: { ...context.server.title, ...Object.fromEntries(event.output.map(i => [i.id, i.title])) },
                  assignee: { ...context.server.assignee, ...Object.fromEntries(event.output.map(i => [i.id, i.assignee])) },
                },
              })),
            },
            onError: { target: "failed", actions: assign({ listError: ({ event }) => errorMessage(event.error) }) },
          },
        },
        loaded: {},
        failed: {},
      },
    },
    detail: {
      initial: "none",
      on: {
        "issue.select": {
          target: ".selected",
          actions: assign(({ context, event }) => ({
            selected: event.id,
            visit: context.visit + 1,
            titleInput: "",
            errors: { ...context.errors, ...Object.fromEntries(DETAIL_CHANNELS.map(c => [c, undefined])) },
          })),
        },
      },
      states: {
        none: {},
        selected: {
          type: "parallel",
          on: {
            rename: {
              guard: "titleTyped",
              actions: {
                type: "startWrite",
                params: ({ context }) => ({
                  request: { kind: "rename", issueId: context.selected!, title: context.titleInput },
                  origin: "detail",
                }),
              },
            },
            post: {
              guard: "commentTyped",
              actions: [
                {
                  type: "startWrite",
                  params: ({ context }) => ({
                    request: { kind: "post", issueId: context.selected!, author: context.user, text: context.commentInput },
                    origin: "detail",
                  }),
                },
                assign({ commentInput: "" }),
              ],
            },
            "label.add": {
              guard: "newLabelTyped",
              actions: [
                {
                  type: "startWrite",
                  params: ({ context }) => ({
                    request: { kind: "addLabel", issueId: context.selected!, label: context.labelInput },
                    origin: "detail",
                  }),
                },
                assign({ labelInput: "" }),
              ],
            },
            "label.remove": {
              actions: {
                type: "startWrite",
                params: ({ context, event }) => ({
                  request: { kind: "removeLabel", issueId: context.selected!, label: event.label },
                  origin: "detail",
                }),
              },
            },
          },
          states: {
            issue: {
              initial: "loading",
              on: { "detail.retry": { target: ".loading" } },
              states: {
                loading: {
                  invoke: {
                    src: "fetchIssue",
                    input: ({ context }) => context.selected!,
                    onDone: [
                      { guard: ({ event }) => event.output === null, target: "notFound" },
                      {
                        target: "loaded",
                        actions: assign(({ context, event }) => {
                          const detail = event.output!;
                          return { detail, server: { ...context.server, title: { ...context.server.title, [detail.id]: detail.title } } };
                        }),
                      },
                    ],
                    onError: { target: "failed", actions: assign({ detailError: ({ event }) => errorMessage(event.error) }) },
                  },
                },
                loaded: {
                  initial: "findingRelated",
                  states: {
                    findingRelated: {
                      invoke: {
                        src: "searchHelp",
                        input: ({ context }) => context.detail!.title,
                        onDone: {
                          target: "related",
                          actions: assign({ related: ({ context, event }) => ({ query: context.detail!.title, hits: event.output }) }),
                        },
                        onError: { target: "relatedFailed", actions: assign({ relatedError: ({ event }) => errorMessage(event.error) }) },
                      },
                    },
                    related: {},
                    relatedFailed: {},
                  },
                },
                notFound: {},
                failed: {},
              },
            },
            comments: {
              initial: "loading",
              states: {
                loading: {
                  entry: assign({ comments: null }),
                  invoke: {
                    src: "fetchComments",
                    input: ({ context }) => context.selected!,
                    onDone: { target: "loaded", actions: assign({ comments: ({ event }) => event.output }) },
                    onError: { target: "failed", actions: assign({ commentsError: ({ event }) => errorMessage(event.error) }) },
                  },
                },
                loaded: {},
                failed: {},
              },
            },
            labels: {
              initial: "loading",
              states: {
                loading: {
                  entry: assign({ labels: null }),
                  invoke: {
                    src: "fetchLabels",
                    input: ({ context }) => context.selected!,
                    onDone: { target: "loaded", actions: assign({ labels: ({ event }) => event.output }) },
                    onError: { target: "failed", actions: assign({ labelsError: ({ event }) => errorMessage(event.error) }) },
                  },
                },
                loaded: {},
                failed: {},
              },
            },
          },
        },
      },
    },
  },
});

/** the number of rows in the open list as the page shows it, or null while it shows something else */
export function openCount(snapshot: SnapshotFrom<typeof issuesMachine>) {
  return snapshot.context.filter === "open" && snapshot.matches({ list: "loaded" }) ? shownRows(snapshot.context).length : null;
}
