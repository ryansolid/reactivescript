import { Array, Effect, Option, Schema } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Api from './api'
import { request } from './request'

// The archive page: archived cards, most recently archived first, each of which can be restored to the board.

// MODEL

const Archived = Schema.Struct({ id: Schema.Number, title: Schema.String })
type Archived = typeof Archived.Type

export const ListState = defineTaggedUnion({
  Loading: {},
  Loaded: { cards: Schema.Array(Archived) },
  Failed: { error: Schema.String },
})

// A restore still in the air, each with its own seq so that two restores of one row settle separately.
const Restoring = Schema.Struct({ seq: Schema.Number, id: Schema.Number })

export const Model = Schema.Struct({
  list: ListState,
  seq: Schema.Number,
  restoring: Schema.Array(Restoring),
  maybeRestoreError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchArchived: { cards: Schema.Array(Archived) },
  FailedFetchArchived: { error: Schema.String },
  ClickedRestore: { id: Schema.Number },
  SucceededRestore: { seq: Schema.Number, id: Schema.Number },
  FailedRestore: { seq: Schema.Number, error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const FetchArchived = Command.define('FetchArchived', {
  args: {},
  messages: [Message.SucceededFetchArchived, Message.FailedFetchArchived],
  execute: () =>
    request(() => Api.fetchArchived()).pipe(
      Effect.map(cards => Message.SucceededFetchArchived({ cards })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchArchived({ error }))),
    ),
})

const RestoreCard = Command.define('RestoreCard', {
  args: { seq: Schema.Number, id: Schema.Number },
  messages: [Message.SucceededRestore, Message.FailedRestore],
  execute: ({ seq, id }) =>
    request(() => Api.restoreCard(id)).pipe(
      Effect.as(Message.SucceededRestore({ seq, id })),
      Effect.catch(error => Effect.succeed(Message.FailedRestore({ seq, error }))),
    ),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: { list: ListState.Loading(), seq: 1, restoring: [], maybeRestoreError: Option.none() },
  commands: [FetchArchived({})],
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const settleRestore = (model: Model, seq: number): Model =>
  modifyFields(model, { restoring: Array.filter(restoring => restoring.seq !== seq) })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchArchived: ({ cards }) => ({ model: modifyFields(model, { list: () => ListState.Loaded({ cards }) }) }),

    FailedFetchArchived: ({ error }) => ({ model: modifyFields(model, { list: () => ListState.Failed({ error }) }) }),

    ClickedRestore: ({ id }) => ({
      model: modifyFields(model, {
        seq: seq => seq + 1,
        maybeRestoreError: () => Option.none(),
        restoring: Array.append({ seq: model.seq, id }),
      }),
      commands: [RestoreCard({ seq: model.seq, id })],
    }),

    SucceededRestore: ({ seq, id }) => ({
      model: modifyFields(settleRestore(model, seq), {
        list: list =>
          ListState.match(list, {
            Loading: () => list,
            Failed: () => list,
            Loaded: ({ cards }) => ListState.Loaded({ cards: Array.filter(cards, card => card.id !== id) }),
          }),
      }),
    }),

    FailedRestore: ({ seq, error }) => ({
      model: modifyFields(settleRestore(model, seq), { maybeRestoreError: () => Option.some(error) }),
    }),
  })

// VIEW

const testId = (h: HtmlBuilder<Message>, id: string) => h.DataAttribute('testid', id)

const archivedRow = (card: Archived, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(String(card.id), [], [
    h.span([testId(h, 'archived-card')], [`#${card.id} ${card.title}`]),
    ' ',
    h.button([testId(h, 'restore'), h.OnClick(Message.ClickedRestore({ id: card.id }))], ['restore']),
  ])

const listView = (model: Model, h: HtmlBuilder<Message>): Html =>
  ListState.match(model.list, {
    Loading: () => h.p([], ['loading archive']),
    Failed: ({ error }) => h.p([], [`archive error: ${error}`]),
    Loaded: ({ cards }) =>
      h.ul(
        [],
        cards
          .filter(card => !Array.some(model.restoring, restoring => restoring.id === card.id))
          .map(card => archivedRow(card, h)),
      ),
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section([], [
    h.div([testId(h, 'archived')], [listView(model, h)]),
    Option.match(model.maybeRestoreError, {
      onNone: () => h.empty,
      onSome: error => h.p([testId(h, 'restore-error')], [`restore error: ${error}`]),
    }),
  ]),
)
