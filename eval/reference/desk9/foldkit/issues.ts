import { Array, Effect, Match, Option, Schema, pipe } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Api from './api'
import * as Comments from './comments'
import * as Labels from './labels'
import { request } from './request'

// MODEL

const Filter = Schema.Literals(['open', 'closed'])
type Filter = typeof Filter.Type

const Issue = Schema.Struct({ id: Schema.Number, title: Schema.String, assignee: Schema.NullOr(Schema.String) })
type Issue = typeof Issue.Type
const Detail = Schema.Struct({ id: Schema.Number, title: Schema.String, body: Schema.String })
const Hit = Schema.Struct({ id: Schema.Number, name: Schema.String })

export const ListState = defineTaggedUnion({
  Loading: {},
  Loaded: { issues: Schema.Array(Issue) },
  Failed: { error: Schema.String },
})
type ListState = typeof ListState.Type

export const DetailState = defineTaggedUnion({
  Loading: {},
  Loaded: { detail: Detail },
  NotFound: {},
  Failed: { error: Schema.String },
})

export const RelatedState = defineTaggedUnion({
  Loading: {},
  Loaded: { hits: Schema.Array(Hit) },
  Failed: { error: Schema.String },
})

// Where a write was started: the detail's buttons or a list row's. Each place reports its own failures.
const Origin = Schema.Literals(['Detail', 'Row'])
type Origin = typeof Origin.Type

// A write still in the air. `seq` orders writes: the newest one started on an issue is what the issue shows.
const Guess = Schema.Struct({ seq: Schema.Number, id: Schema.Number, value: Schema.String })
type Guess = typeof Guess.Type
const Closing = Schema.Struct({ seq: Schema.Number, id: Schema.Number })

// An error that belongs to one issue: shown only while that issue is selected.
const IssueError = Schema.Struct({ id: Schema.Number, message: Schema.String })
type IssueError = typeof IssueError.Type

export const Model = Schema.Struct({
  user: Schema.String,
  filter: Filter,
  listSeq: Schema.Number,
  list: ListState,
  maybeSelected: Schema.Option(Schema.Number),
  detailSeq: Schema.Number,
  detail: DetailState,
  seq: Schema.Number,
  assigning: Schema.Array(Guess),
  lastAssign: Schema.Number,
  maybeAssignError: Schema.Option(IssueError),
  titleInput: Schema.String,
  renaming: Schema.Array(Guess),
  lastRename: Schema.Number,
  maybeRenameError: Schema.Option(IssueError),
  closing: Schema.Array(Closing),
  lastClose: Schema.Number,
  maybeCloseError: Schema.Option(IssueError),
  lastRowAction: Schema.Number,
  maybeRowError: Schema.Option(Schema.String),
  maybeRelatedTitle: Schema.Option(Schema.String),
  relatedSeq: Schema.Number,
  related: RelatedState,
  labels: Labels.Model,
  comments: Comments.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedUser: { value: Schema.String },
  ClickedFilter: { filter: Filter },
  SucceededFetchIssues: { seq: Schema.Number, issues: Schema.Array(Issue) },
  FailedFetchIssues: { seq: Schema.Number, error: Schema.String },
  ClickedIssue: { id: Schema.Number },
  ClickedRetry: {},
  SucceededFetchIssue: { seq: Schema.Number, maybeDetail: Schema.Option(Detail) },
  FailedFetchIssue: { seq: Schema.Number, error: Schema.String },
  ClickedAssign: {},
  ClickedRowAssign: { id: Schema.Number },
  SucceededAssign: { seq: Schema.Number, id: Schema.Number, assignee: Schema.String },
  FailedAssign: { seq: Schema.Number, origin: Origin, id: Schema.Number, error: Schema.String },
  UpdatedTitleInput: { value: Schema.String },
  ClickedRename: {},
  SucceededRename: { seq: Schema.Number, id: Schema.Number, title: Schema.String },
  FailedRename: { seq: Schema.Number, id: Schema.Number, error: Schema.String },
  ClickedClose: {},
  ClickedRowClose: { id: Schema.Number },
  SucceededClose: { seq: Schema.Number, id: Schema.Number },
  FailedClose: { seq: Schema.Number, origin: Origin, id: Schema.Number, error: Schema.String },
  SucceededSearchRelated: { seq: Schema.Number, hits: Schema.Array(Hit) },
  FailedSearchRelated: { seq: Schema.Number, error: Schema.String },
  ClickedRelatedHit: { query: Schema.String, id: Schema.Number },
  GotLabelsMessage: { message: Labels.Message },
  GotCommentsMessage: { message: Comments.Message },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  OpenedRelatedHelp: { query: Schema.String, id: Schema.Number },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

const FetchIssues = Command.define('FetchIssues', {
  args: { seq: Schema.Number, filter: Filter },
  messages: [Message.SucceededFetchIssues, Message.FailedFetchIssues],
  execute: ({ seq, filter }) =>
    request(() => Api.fetchIssues(filter)).pipe(
      Effect.map(issues => Message.SucceededFetchIssues({ seq, issues })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchIssues({ seq, error }))),
    ),
})

const FetchIssue = Command.define('FetchIssue', {
  args: { seq: Schema.Number, id: Schema.Number },
  messages: [Message.SucceededFetchIssue, Message.FailedFetchIssue],
  execute: ({ seq, id }) =>
    request(() => Api.fetchIssue(id)).pipe(
      Effect.map(detail => Message.SucceededFetchIssue({ seq, maybeDetail: Option.fromNullishOr(detail) })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchIssue({ seq, error }))),
    ),
})

const Assign = Command.define('Assign', {
  args: { seq: Schema.Number, origin: Origin, id: Schema.Number, user: Schema.String },
  messages: [Message.SucceededAssign, Message.FailedAssign],
  execute: ({ seq, origin, id, user }) =>
    request(() => Api.assign(id, user)).pipe(
      Effect.map(answer => Message.SucceededAssign({ seq, id, assignee: answer.assignee })),
      Effect.catch(error => Effect.succeed(Message.FailedAssign({ seq, origin, id, error }))),
    ),
})

const Rename = Command.define('Rename', {
  args: { seq: Schema.Number, id: Schema.Number, title: Schema.String },
  messages: [Message.SucceededRename, Message.FailedRename],
  execute: ({ seq, id, title }) =>
    request(() => Api.renameIssue(id, title)).pipe(
      Effect.map(answer => Message.SucceededRename({ seq, id, title: answer.title })),
      Effect.catch(error => Effect.succeed(Message.FailedRename({ seq, id, error }))),
    ),
})

const Close = Command.define('Close', {
  args: { seq: Schema.Number, origin: Origin, id: Schema.Number },
  messages: [Message.SucceededClose, Message.FailedClose],
  execute: ({ seq, origin, id }) =>
    request(() => Api.closeIssue(id)).pipe(
      Effect.as(Message.SucceededClose({ seq, id })),
      Effect.catch(error => Effect.succeed(Message.FailedClose({ seq, origin, id, error }))),
    ),
})

const SearchRelated = Command.define('SearchRelated', {
  args: { seq: Schema.Number, title: Schema.String },
  messages: [Message.SucceededSearchRelated, Message.FailedSearchRelated],
  execute: ({ seq, title }) =>
    request(() => Api.search(title)).pipe(
      Effect.map(hits => Message.SucceededSearchRelated({ seq, hits })),
      Effect.catch(error => Effect.succeed(Message.FailedSearchRelated({ seq, error }))),
    ),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: {
    user: 'guest',
    filter: 'open',
    listSeq: 1,
    list: ListState.Loading(),
    maybeSelected: Option.none(),
    detailSeq: 0,
    detail: DetailState.Loading(),
    seq: 1,
    assigning: [],
    lastAssign: 0,
    maybeAssignError: Option.none(),
    titleInput: '',
    renaming: [],
    lastRename: 0,
    maybeRenameError: Option.none(),
    closing: [],
    lastClose: 0,
    maybeCloseError: Option.none(),
    lastRowAction: 0,
    maybeRowError: Option.none(),
    maybeRelatedTitle: Option.none(),
    relatedSeq: 0,
    related: RelatedState.Loading(),
    labels: Labels.init(),
    comments: Comments.init(),
  },
  commands: [FetchIssues({ seq: 1, filter: 'open' })],
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>
type UpdateStep = Update.Step<Model, Message>

const readLabels = (model: Model): Option.Option<Labels.Model> => Option.some(model.labels)
const writeLabels = (model: Model, nextLabels: Labels.Model): Model => modifyFields(model, { labels: () => nextLabels })
const toGotLabelsMessage = (message: Labels.Message): Message => Message.GotLabelsMessage({ message })

const foldLabels = Update.foldChild({
  update: Labels.update,
  read: readLabels,
  write: writeLabels,
  toParentMessage: toGotLabelsMessage,
})

const selectLabels = Update.foldChild({
  update: Labels.select,
  read: readLabels,
  write: writeLabels,
  toParentMessage: toGotLabelsMessage,
})

const readComments = (model: Model): Option.Option<Comments.Model> => Option.some(model.comments)
const writeComments = (model: Model, nextComments: Comments.Model): Model =>
  modifyFields(model, { comments: () => nextComments })
const toGotCommentsMessage = (message: Comments.Message): Message => Message.GotCommentsMessage({ message })

const foldComments = (user: string) =>
  Update.foldChild({
    update: (comments: Comments.Model, message: Comments.Message) => Comments.update(comments, message, { user }),
    read: readComments,
    write: writeComments,
    toParentMessage: toGotCommentsMessage,
  })

const selectComments = Update.foldChild({
  update: Comments.select,
  read: readComments,
  write: writeComments,
  toParentMessage: toGotCommentsMessage,
})

const dropSettled =
  (seq: number) =>
  <A extends { readonly seq: number }>(writes: ReadonlyArray<A>): ReadonlyArray<A> =>
    Array.filter(writes, write => write.seq !== seq)

const latestGuess = (guesses: ReadonlyArray<Guess>, id: number): Option.Option<string> =>
  pipe(
    guesses,
    Array.filter(guess => guess.id === id),
    Array.last,
    Option.map(guess => guess.value),
  )

const isClosing = (model: Model, id: number): boolean => Array.some(model.closing, closing => closing.id === id)

const isSelected = (model: Model, id: number): boolean => Option.contains(model.maybeSelected, id)

/** The server's rows with the writes still in the air laid over them. */
const shownIssues = (model: Model, issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> =>
  pipe(
    issues,
    Array.filter(issue => !(model.filter === 'open' && isClosing(model, issue.id))),
    Array.map(issue => ({
      ...issue,
      title: Option.getOrElse(latestGuess(model.renaming, issue.id), () => issue.title),
      assignee: Option.getOrElse(latestGuess(model.assigning, issue.id), () => issue.assignee),
    })),
  )

/** The title the detail's heading shows, once the detail has loaded. */
const shownTitle = (model: Model): Option.Option<string> =>
  DetailState.match(model.detail, {
    Loading: () => Option.none(),
    NotFound: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: ({ detail }) => Option.some(Option.getOrElse(latestGuess(model.renaming, detail.id), () => detail.title)),
  })

/** The open list as shown, closes in the air already out of it. Other lists, loads and failures have no count. */
export const openCount = (model: Model): Option.Option<number> =>
  model.filter === 'open' && model.list._tag === 'Loaded'
    ? Option.some(shownIssues(model, model.list.issues).length)
    : Option.none()

const mapIssue =
  (id: number, f: (issue: Issue) => Issue) =>
  (list: ListState): ListState =>
    ListState.match(list, {
      Loading: () => list,
      Failed: () => list,
      Loaded: ({ issues }) => ListState.Loaded({ issues: Array.map(issues, issue => (issue.id === id ? f(issue) : issue)) }),
    })

// What the server answered a write: it holds for the issue whatever page visit or selection started the write.

const withServerAssignee = (model: Model, id: number, assignee: string): Model =>
  modifyFields(model, { list: mapIssue(id, issue => ({ ...issue, assignee })) })

const withServerTitle = (model: Model, id: number, title: string): Model =>
  modifyFields(model, {
    list: mapIssue(id, issue => ({ ...issue, title })),
    detail: detail =>
      detail._tag === 'Loaded' && detail.detail.id === id
        ? DetailState.Loaded({ detail: { ...detail.detail, title } })
        : detail,
  })

const withServerClosed = (model: Model, id: number): Model =>
  modifyFields(model, {
    list: list =>
      model.filter === 'open' && list._tag === 'Loaded'
        ? ListState.Loaded({ issues: Array.filter(list.issues, issue => issue.id !== id) })
        : list,
  })

// Related help follows the title the detail shows: whenever that changes, it is searched again.
const followRelated: UpdateStep = model => {
  const maybeTitle = shownTitle(model)
  const isSameTitle = Option.match(maybeTitle, {
    onNone: () => Option.isNone(model.maybeRelatedTitle),
    onSome: title => Option.contains(model.maybeRelatedTitle, title),
  })
  if (isSameTitle) {
    return { model }
  }
  const relatedSeq = model.relatedSeq + 1
  return {
    model: modifyFields(model, {
      maybeRelatedTitle: () => maybeTitle,
      relatedSeq: () => relatedSeq,
      related: () => RelatedState.Loading(),
    }),
    commands: Option.match(maybeTitle, {
      onNone: () => [],
      onSome: title => [SearchRelated({ seq: relatedSeq, title })],
    }),
  }
}

const selectIssue =
  (id: number): UpdateStep =>
  model => {
    const detailSeq = model.detailSeq + 1
    return {
      model: modifyFields(model, {
        maybeSelected: () => Option.some(id),
        detailSeq: () => detailSeq,
        detail: () => DetailState.Loading(),
        titleInput: () => '',
        maybeAssignError: () => Option.none(),
        maybeRenameError: () => Option.none(),
        maybeCloseError: () => Option.none(),
      }),
      commands: [FetchIssue({ seq: detailSeq, id })],
    }
  }

// A row action clears the row error; only the newest one reports its failure.
const beginRowAction = (model: Model): Model =>
  modifyFields(model, { lastRowAction: () => model.seq, maybeRowError: () => Option.none() })

const startAssign = (model: Model, origin: Origin, id: number): UpdateReturn => {
  const started =
    origin === 'Row'
      ? beginRowAction(model)
      : modifyFields(model, { lastAssign: () => model.seq, maybeAssignError: () => Option.none() })
  return {
    model: modifyFields(started, {
      seq: seq => seq + 1,
      assigning: Array.append({ seq: model.seq, id, value: model.user }),
    }),
    commands: [Assign({ seq: model.seq, origin, id, user: model.user })],
  }
}

const startClose = (model: Model, origin: Origin, id: number): UpdateReturn => {
  const started =
    origin === 'Row'
      ? beginRowAction(model)
      : modifyFields(model, { lastClose: () => model.seq, maybeCloseError: () => Option.none() })
  return {
    model: modifyFields(started, { seq: seq => seq + 1, closing: Array.append({ seq: model.seq, id }) }),
    commands: [Close({ seq: model.seq, origin, id })],
  }
}

// Only the newest write of a kind, from one place, reports its failure.
const failure = (last: number, seq: number, id: number, message: string) => (current: Option.Option<IssueError>) =>
  last === seq ? Option.some({ id, message }) : current

const reportRowFailure = (model: Model, seq: number, message: string): Model =>
  modifyFields(model, { maybeRowError: current => (model.lastRowAction === seq ? Option.some(message) : current) })

const updatePage = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedUser: ({ value }) => ({ model: modifyFields(model, { user: () => value }) }),

    ClickedFilter: ({ filter }) => {
      if (filter === model.filter) {
        return { model }
      }
      const listSeq = model.listSeq + 1
      return {
        model: modifyFields(model, { filter: () => filter, listSeq: () => listSeq, list: () => ListState.Loading() }),
        commands: [FetchIssues({ seq: listSeq, filter })],
      }
    },

    SucceededFetchIssues: ({ seq, issues }) =>
      seq === model.listSeq ? { model: modifyFields(model, { list: () => ListState.Loaded({ issues }) }) } : { model },

    FailedFetchIssues: ({ seq, error }) =>
      seq === model.listSeq ? { model: modifyFields(model, { list: () => ListState.Failed({ error }) }) } : { model },

    ClickedIssue: ({ id }) =>
      isSelected(model, id) ? { model } : Update.combine(model, [selectIssue(id), selectLabels(id), selectComments(id)]),

    ClickedRetry: () =>
      Option.match(model.maybeSelected, {
        onNone: () => ({ model }),
        onSome: id => {
          const detailSeq = model.detailSeq + 1
          return {
            model: modifyFields(model, { detailSeq: () => detailSeq, detail: () => DetailState.Loading() }),
            commands: [FetchIssue({ seq: detailSeq, id })],
          }
        },
      }),

    SucceededFetchIssue: ({ seq, maybeDetail }) =>
      seq === model.detailSeq
        ? {
            model: modifyFields(model, {
              detail: () =>
                Option.match(maybeDetail, {
                  onNone: () => DetailState.NotFound(),
                  onSome: detail => DetailState.Loaded({ detail }),
                }),
            }),
          }
        : { model },

    FailedFetchIssue: ({ seq, error }) =>
      seq === model.detailSeq ? { model: modifyFields(model, { detail: () => DetailState.Failed({ error }) }) } : { model },

    ClickedAssign: () =>
      Option.match(model.maybeSelected, {
        onNone: () => ({ model }),
        onSome: id => startAssign(model, 'Detail', id),
      }),

    ClickedRowAssign: ({ id }) => startAssign(model, 'Row', id),

    SucceededAssign: ({ seq, id, assignee }) => ({
      model: withServerAssignee(modifyFields(model, { assigning: dropSettled(seq) }), id, assignee),
    }),

    FailedAssign: ({ seq, origin, id, error }) => {
      const settled = modifyFields(model, { assigning: dropSettled(seq) })
      return {
        model:
          origin === 'Row'
            ? reportRowFailure(settled, seq, error)
            : modifyFields(settled, { maybeAssignError: failure(model.lastAssign, seq, id, error) }),
      }
    },

    UpdatedTitleInput: ({ value }) => ({ model: modifyFields(model, { titleInput: () => value }) }),

    ClickedRename: () =>
      Option.match(model.maybeSelected, {
        onNone: () => ({ model }),
        onSome: id =>
          model.titleInput === ''
            ? { model }
            : {
                model: modifyFields(model, {
                  seq: seq => seq + 1,
                  lastRename: () => model.seq,
                  maybeRenameError: () => Option.none(),
                  renaming: Array.append({ seq: model.seq, id, value: model.titleInput }),
                }),
                commands: [Rename({ seq: model.seq, id, title: model.titleInput })],
              },
      }),

    SucceededRename: ({ seq, id, title }) => ({
      model: withServerTitle(modifyFields(model, { renaming: dropSettled(seq) }), id, title),
    }),

    FailedRename: ({ seq, id, error }) => ({
      model: modifyFields(model, {
        renaming: dropSettled(seq),
        maybeRenameError: failure(model.lastRename, seq, id, error),
      }),
    }),

    ClickedClose: () =>
      Option.match(model.maybeSelected, {
        onNone: () => ({ model }),
        onSome: id => startClose(model, 'Detail', id),
      }),

    ClickedRowClose: ({ id }) => startClose(model, 'Row', id),

    SucceededClose: ({ seq, id }) => ({
      model: withServerClosed(modifyFields(model, { closing: dropSettled(seq) }), id),
    }),

    FailedClose: ({ seq, origin, id, error }) => {
      const settled = modifyFields(model, { closing: dropSettled(seq) })
      return {
        model:
          origin === 'Row'
            ? reportRowFailure(settled, seq, error)
            : modifyFields(settled, { maybeCloseError: failure(model.lastClose, seq, id, error) }),
      }
    },

    SucceededSearchRelated: ({ seq, hits }) =>
      seq === model.relatedSeq ? { model: modifyFields(model, { related: () => RelatedState.Loaded({ hits }) }) } : { model },

    FailedSearchRelated: ({ seq, error }) =>
      seq === model.relatedSeq ? { model: modifyFields(model, { related: () => RelatedState.Failed({ error }) }) } : { model },

    ClickedRelatedHit: ({ query, id }) => ({ model, outMessage: OutMessage.OpenedRelatedHelp({ query, id }) }),

    GotLabelsMessage: ({ message }) => foldLabels(model, message),

    GotCommentsMessage: ({ message }) => foldComments(model.user)(model, message),
  })

export const update = (model: Model, message: Message): UpdateReturn => {
  const pageUpdate = updatePage(model, message)
  const relatedFollow = followRelated(pageUpdate.model)
  return Update.withOutMessage(
    { model: relatedFollow.model, commands: [...(pageUpdate.commands ?? []), ...(relatedFollow.commands ?? [])] },
    pageUpdate.outMessage,
  )
}

/** An answer to a write made on an earlier visit of the issues page. Its guesses and errors went with that visit,
 *  but what the server took still holds and shows on this one. */
export const learnFromEarlierVisit = (model: Model, message: Message): Update.Return<Model, Message> => {
  const learned = Match.value(message).pipe(
    Match.tag('SucceededAssign', ({ id, assignee }) => withServerAssignee(model, id, assignee)),
    Match.tag('SucceededRename', ({ id, title }) => withServerTitle(model, id, title)),
    Match.tag('SucceededClose', ({ id }) => withServerClosed(model, id)),
    Match.tag('GotLabelsMessage', ({ message }) =>
      modifyFields(model, { labels: labels => Labels.learnFromEarlierVisit(labels, message) }),
    ),
    Match.tag('GotCommentsMessage', ({ message }) =>
      modifyFields(model, { comments: comments => Comments.learnFromEarlierVisit(comments, message) }),
    ),
    Match.orElse(() => model),
  )
  return followRelated(learned)
}

// VIEW

const testId = (h: HtmlBuilder<Message>, id: string) => h.DataAttribute('testid', id)

const issueRow = (model: Model, issue: Issue, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(String(issue.id), [], [
    h.button(
      [testId(h, 'issue'), h.AriaPressed(String(isSelected(model, issue.id))), h.OnClick(Message.ClickedIssue({ id: issue.id }))],
      [`#${issue.id} ${issue.title} (${issue.assignee ?? 'unassigned'})`],
    ),
    ' ',
    h.button([testId(h, 'row-assign'), h.OnClick(Message.ClickedRowAssign({ id: issue.id }))], [`assign to ${model.user}`]),
    model.filter === 'open'
      ? h.button([testId(h, 'row-close'), h.OnClick(Message.ClickedRowClose({ id: issue.id }))], ['close'])
      : h.empty,
  ])

const listView = (model: Model, h: HtmlBuilder<Message>): Html =>
  ListState.match(model.list, {
    Loading: () => h.p([], [`loading ${model.filter} issues`]),
    Failed: ({ error }) => h.p([], [`list error: ${error}`]),
    Loaded: ({ issues }) =>
      h.ul(
        [],
        Array.map(shownIssues(model, issues), issue => issueRow(model, issue, h)),
      ),
  })

const errorLine = (model: Model, maybeError: Option.Option<IssueError>, prefix: string, h: HtmlBuilder<Message>): Html =>
  pipe(
    maybeError,
    Option.filter(error => isSelected(model, error.id)),
    Option.match({ onNone: () => h.empty, onSome: error => h.p([], [`${prefix}${error.message}`]) }),
  )

const assignErrorLine = (model: Model, h: HtmlBuilder<Message>): Html =>
  pipe(
    model.maybeAssignError,
    Option.filter(error => isSelected(model, error.id)),
    Option.match({ onNone: () => h.empty, onSome: error => h.p([testId(h, 'assign-error')], [error.message]) }),
  )

const relatedHits = (model: Model, hits: ReadonlyArray<typeof Hit.Type>, h: HtmlBuilder<Message>): Html =>
  Array.match(hits, {
    onEmpty: () => h.p([], ['no related help']),
    onNonEmpty: nonEmpty =>
      h.ul(
        [],
        Array.map(Array.take(nonEmpty, 3), hit =>
          h.keyed('li')(String(hit.id), [], [
            h.button(
              [
                testId(h, 'related-hit'),
                h.OnClick(
                  Message.ClickedRelatedHit({ query: Option.getOrElse(model.maybeRelatedTitle, () => ''), id: hit.id }),
                ),
              ],
              [hit.name],
            ),
          ]),
        ),
      ),
  })

const relatedView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [testId(h, 'related')],
    [
      RelatedState.match(model.related, {
        Loading: () => h.p([], ['finding related help']),
        Failed: ({ error }) => h.p([], [`related help failed: ${error}`]),
        Loaded: ({ hits }) => relatedHits(model, hits, h),
      }),
    ],
  )

const detailBody = (model: Model, id: number, h: HtmlBuilder<Message>): Html =>
  DetailState.match(model.detail, {
    Loading: () => h.p([], [`loading #${id}`]),
    NotFound: () => h.p([], [`detail error: issue #${id} not found`]),
    Failed: ({ error }) => h.p([], [`detail error: ${error}`]),
    Loaded: ({ detail }) =>
      h.div([], [
        h.h2([], [`#${detail.id} ${Option.getOrElse(shownTitle(model), () => detail.title)}`]),
        h.p([], [detail.body]),
        relatedView(model, h),
      ]),
  })

const detailView = (model: Model, id: number, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  detailBody(model, id, h),
  h.button([testId(h, 'retry'), h.OnClick(Message.ClickedRetry())], ['retry']),
  h.button([testId(h, 'assign'), h.OnClick(Message.ClickedAssign())], [`assign to ${model.user}`]),
  assignErrorLine(model, h),
  h.div([], [
    h.input([testId(h, 'title-input'), h.Value(model.titleInput), h.OnInput(value => Message.UpdatedTitleInput({ value }))]),
    h.button([testId(h, 'rename'), h.OnClick(Message.ClickedRename())], ['rename']),
    errorLine(model, model.maybeRenameError, 'rename error: ', h),
  ]),
  h.button([testId(h, 'close'), h.OnClick(Message.ClickedClose())], ['close']),
  errorLine(model, model.maybeCloseError, 'close error: ', h),
  h.submodel({
    slotId: 'labels',
    model: model.labels,
    view: Labels.view,
    toParentMessage: toGotLabelsMessage,
  }),
  h.submodel({
    slotId: 'comments',
    model: model.comments,
    view: Comments.view,
    toParentMessage: toGotCommentsMessage,
  }),
]

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div([], [
    h.section([], [
      h.label([], [
        'user ',
        h.input([testId(h, 'user'), h.Value(model.user), h.OnInput(value => Message.UpdatedUser({ value }))]),
      ]),
      h.div([], [
        h.button(
          [testId(h, 'filter-open'), h.AriaPressed(String(model.filter === 'open')), h.OnClick(Message.ClickedFilter({ filter: 'open' }))],
          ['open'],
        ),
        h.button(
          [
            testId(h, 'filter-closed'),
            h.AriaPressed(String(model.filter === 'closed')),
            h.OnClick(Message.ClickedFilter({ filter: 'closed' })),
          ],
          ['closed'],
        ),
      ]),
      h.div([testId(h, 'list')], [listView(model, h)]),
      Option.match(model.maybeRowError, {
        onNone: () => h.empty,
        onSome: error => h.p([testId(h, 'row-error')], [`row error: ${error}`]),
      }),
    ]),
    h.section(
      [testId(h, 'detail')],
      Option.match(model.maybeSelected, {
        onNone: () => [h.p([], ['select an issue'])],
        onSome: id => detailView(model, id, h),
      }),
    ),
  ]),
)
