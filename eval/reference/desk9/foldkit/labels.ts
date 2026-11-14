import { Array, Effect, Match, Option, Schema, pipe } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Api from './api'
import { request } from './request'

// The selected issue's labels. The model lives as long as the issues page, so label changes still in the air are
// laid over whatever the issue's labels answer, also after the issue was selected again.

// MODEL

export const LabelsState = defineTaggedUnion({
  Loading: {},
  Loaded: { labels: Schema.Array(Schema.String) },
  Failed: { error: Schema.String },
})
type LabelsState = typeof LabelsState.Type

const ChangeKind = Schema.Literals(['Add', 'Remove'])
type ChangeKind = typeof ChangeKind.Type

const Change = Schema.Struct({ seq: Schema.Number, issueId: Schema.Number, kind: ChangeKind, label: Schema.String })
type Change = typeof Change.Type

const LabelError = Schema.Struct({ issueId: Schema.Number, message: Schema.String })

export const Model = Schema.Struct({
  maybeIssueId: Schema.Option(Schema.Number),
  loadSeq: Schema.Number,
  labels: LabelsState,
  input: Schema.String,
  seq: Schema.Number,
  changes: Schema.Array(Change),
  lastChange: Schema.Number,
  maybeError: Schema.Option(LabelError),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchLabels: { seq: Schema.Number, labels: Schema.Array(Schema.String) },
  FailedFetchLabels: { seq: Schema.Number, error: Schema.String },
  UpdatedInput: { value: Schema.String },
  ClickedAdd: {},
  ClickedRemove: { label: Schema.String },
  SucceededAddLabel: { seq: Schema.Number, issueId: Schema.Number, labels: Schema.Array(Schema.String) },
  FailedAddLabel: { seq: Schema.Number, issueId: Schema.Number, error: Schema.String },
  SucceededRemoveLabel: { seq: Schema.Number, issueId: Schema.Number, labels: Schema.Array(Schema.String) },
  FailedRemoveLabel: { seq: Schema.Number, issueId: Schema.Number, error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const FetchLabels = Command.define('FetchLabels', {
  args: { seq: Schema.Number, issueId: Schema.Number },
  messages: [Message.SucceededFetchLabels, Message.FailedFetchLabels],
  execute: ({ seq, issueId }) =>
    request(() => Api.fetchLabels(issueId)).pipe(
      Effect.map(labels => Message.SucceededFetchLabels({ seq, labels })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchLabels({ seq, error }))),
    ),
})

const AddLabel = Command.define('AddLabel', {
  args: { seq: Schema.Number, issueId: Schema.Number, label: Schema.String },
  messages: [Message.SucceededAddLabel, Message.FailedAddLabel],
  execute: ({ seq, issueId, label }) =>
    request(() => Api.addLabel(issueId, label)).pipe(
      Effect.map(labels => Message.SucceededAddLabel({ seq, issueId, labels })),
      Effect.catch(error => Effect.succeed(Message.FailedAddLabel({ seq, issueId, error }))),
    ),
})

const RemoveLabel = Command.define('RemoveLabel', {
  args: { seq: Schema.Number, issueId: Schema.Number, label: Schema.String },
  messages: [Message.SucceededRemoveLabel, Message.FailedRemoveLabel],
  execute: ({ seq, issueId, label }) =>
    request(() => Api.removeLabel(issueId, label)).pipe(
      Effect.map(labels => Message.SucceededRemoveLabel({ seq, issueId, labels })),
      Effect.catch(error => Effect.succeed(Message.FailedRemoveLabel({ seq, issueId, error }))),
    ),
})

// INIT

export const init = (): Model => ({
  maybeIssueId: Option.none(),
  loadSeq: 0,
  labels: LabelsState.Loading(),
  input: '',
  seq: 1,
  changes: [],
  lastChange: 0,
  maybeError: Option.none(),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

/** Shows the labels of `issueId`, newly selected. */
export const select = (model: Model, issueId: number): UpdateReturn => {
  const loadSeq = model.loadSeq + 1
  return {
    model: modifyFields(model, {
      maybeIssueId: () => Option.some(issueId),
      loadSeq: () => loadSeq,
      labels: () => LabelsState.Loading(),
      maybeError: () => Option.none(),
    }),
    commands: [FetchLabels({ seq: loadSeq, issueId })],
  }
}

const isShowing = (model: Model, issueId: number): boolean => Option.contains(model.maybeIssueId, issueId)

const withChange = (labels: ReadonlyArray<string>, change: Change): ReadonlyArray<string> =>
  change.kind === 'Remove'
    ? Array.filter(labels, label => label !== change.label)
    : Array.contains(labels, change.label)
      ? labels
      : Array.append(labels, change.label)

/** The server's labels with the changes still in the air laid over them, in the order they started. */
const shownLabels = (model: Model, issueId: number, labels: ReadonlyArray<string>): ReadonlyArray<string> =>
  pipe(
    model.changes,
    Array.filter(change => change.issueId === issueId),
    Array.reduce(labels, withChange),
  )

/** The labels the server answered for `issueId`, after one of its changes. */
const withServerLabels = (model: Model, issueId: number, labels: ReadonlyArray<string>): Model =>
  modifyFields(model, {
    labels: current =>
      isShowing(model, issueId) && current._tag === 'Loaded' ? LabelsState.Loaded({ labels }) : current,
  })

const startChange = (model: Model, kind: ChangeKind, label: string): UpdateReturn =>
  Option.match(model.maybeIssueId, {
    onNone: () => ({ model }),
    onSome: issueId => ({
      model: modifyFields(model, {
        seq: seq => seq + 1,
        lastChange: () => model.seq,
        maybeError: () => Option.none(),
        changes: Array.append({ seq: model.seq, issueId, kind, label }),
      }),
      commands: [
        kind === 'Add'
          ? AddLabel({ seq: model.seq, issueId, label })
          : RemoveLabel({ seq: model.seq, issueId, label }),
      ],
    }),
  })

const settleChange = (model: Model, seq: number): Model =>
  modifyFields(model, { changes: Array.filter(change => change.seq !== seq) })

const acceptChange = (model: Model, seq: number, issueId: number, labels: ReadonlyArray<string>): UpdateReturn => ({
  model: withServerLabels(settleChange(model, seq), issueId, labels),
})

// Only the newest label change reports its failure.
const declineChange = (model: Model, seq: number, issueId: number, message: string): UpdateReturn => ({
  model: modifyFields(settleChange(model, seq), {
    maybeError: current => (model.lastChange === seq ? Option.some({ issueId, message }) : current),
  }),
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchLabels: ({ seq, labels }) =>
      seq === model.loadSeq ? { model: modifyFields(model, { labels: () => LabelsState.Loaded({ labels }) }) } : { model },

    FailedFetchLabels: ({ seq, error }) =>
      seq === model.loadSeq ? { model: modifyFields(model, { labels: () => LabelsState.Failed({ error }) }) } : { model },

    UpdatedInput: ({ value }) => ({ model: modifyFields(model, { input: () => value }) }),

    ClickedAdd: () => {
      const label = model.input
      const isNew = Option.match(model.maybeIssueId, {
        onNone: () => false,
        onSome: issueId =>
          model.labels._tag === 'Loaded' && !Array.contains(shownLabels(model, issueId, model.labels.labels), label),
      })
      if (label === '' || !isNew) {
        return { model }
      }
      return startChange(modifyFields(model, { input: () => '' }), 'Add', label)
    },

    ClickedRemove: ({ label }) => startChange(model, 'Remove', label),

    SucceededAddLabel: ({ seq, issueId, labels }) => acceptChange(model, seq, issueId, labels),
    FailedAddLabel: ({ seq, issueId, error }) => declineChange(model, seq, issueId, error),
    SucceededRemoveLabel: ({ seq, issueId, labels }) => acceptChange(model, seq, issueId, labels),
    FailedRemoveLabel: ({ seq, issueId, error }) => declineChange(model, seq, issueId, error),
  })

/** An answer to a change made on an earlier visit of the issues page: the labels the server answered still hold. */
export const learnFromEarlierVisit = (model: Model, message: Message): Model =>
  Match.value(message).pipe(
    Match.tag('SucceededAddLabel', 'SucceededRemoveLabel', ({ issueId, labels }) =>
      withServerLabels(model, issueId, labels),
    ),
    Match.orElse(() => model),
  )

// VIEW

const testId = (h: HtmlBuilder<Message>, id: string) => h.DataAttribute('testid', id)

const labelList = (model: Model, issueId: number, labels: ReadonlyArray<string>, h: HtmlBuilder<Message>): Html =>
  h.ul(
    [],
    Array.map(shownLabels(model, issueId, labels), label =>
      h.keyed('li')(label, [], [
        h.span([testId(h, 'label')], [label]),
        ' ',
        h.button([testId(h, 'remove-label'), h.OnClick(Message.ClickedRemove({ label }))], [`remove ${label}`]),
      ]),
    ),
  )

const labelsState = (model: Model, issueId: number, h: HtmlBuilder<Message>): Html =>
  LabelsState.match(model.labels, {
    Loading: () => h.p([], ['loading labels']),
    Failed: ({ error }) => h.p([], [`labels error: ${error}`]),
    Loaded: ({ labels }) => labelList(model, issueId, labels, h),
  })

const errorLine = (model: Model, issueId: number, h: HtmlBuilder<Message>): Html =>
  pipe(
    model.maybeError,
    Option.filter(error => error.issueId === issueId),
    Option.match({ onNone: () => h.empty, onSome: error => h.p([], [`label error: ${error.message}`]) }),
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Option.match(model.maybeIssueId, {
    onNone: () => h.empty,
    onSome: issueId =>
      h.div([], [
        h.div([testId(h, 'labels')], [labelsState(model, issueId, h)]),
        h.input([testId(h, 'label-input'), h.Value(model.input), h.OnInput(value => Message.UpdatedInput({ value }))]),
        h.button([testId(h, 'add-label'), h.OnClick(Message.ClickedAdd())], ['add label']),
        errorLine(model, issueId, h),
      ]),
  }),
)
