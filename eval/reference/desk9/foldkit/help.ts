import { Array, Effect, Option, Schema } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Api from './api'
import { request } from './request'

// MODEL

const Hit = Schema.Struct({ id: Schema.Number, name: Schema.String })
const Item = Schema.Struct({ id: Schema.Number, name: Schema.String, blurb: Schema.String })

// The results on screen stay until a newer query's answer replaces them.
const Shown = Schema.Struct({ query: Schema.String, hits: Schema.Array(Hit) })

export const ItemState = defineTaggedUnion({
  Loading: {},
  Loaded: { maybeItem: Schema.Option(Item) },
  Failed: { error: Schema.String },
})

export const Model = Schema.Struct({
  query: Schema.String,
  searchSeq: Schema.Number,
  isSearching: Schema.Boolean,
  maybeShown: Schema.Option(Shown),
  maybeSearchError: Schema.Option(Schema.String),
  maybeSelected: Schema.Option(Schema.Number),
  itemSeq: Schema.Number,
  item: ItemState,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedQuery: { value: Schema.String },
  SucceededSearch: { seq: Schema.Number, query: Schema.String, hits: Schema.Array(Hit) },
  FailedSearch: { seq: Schema.Number, error: Schema.String },
  ClickedHit: { id: Schema.Number },
  SucceededFetchItem: { seq: Schema.Number, item: Schema.NullOr(Item) },
  FailedFetchItem: { seq: Schema.Number, error: Schema.String },
  ClickedRetryItem: {},
})
export type Message = typeof Message.Type

// COMMAND

const Search = Command.define('Search', {
  args: { seq: Schema.Number, query: Schema.String },
  messages: [Message.SucceededSearch, Message.FailedSearch],
  execute: ({ seq, query }) =>
    request(() => Api.search(query)).pipe(
      Effect.map(hits => Message.SucceededSearch({ seq, query, hits })),
      Effect.catch(error => Effect.succeed(Message.FailedSearch({ seq, error }))),
    ),
})

const FetchItem = Command.define('FetchItem', {
  args: { seq: Schema.Number, id: Schema.Number },
  messages: [Message.SucceededFetchItem, Message.FailedFetchItem],
  execute: ({ seq, id }) =>
    request(() => Api.fetchItem(id)).pipe(
      Effect.map(item => Message.SucceededFetchItem({ seq, item })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchItem({ seq, error }))),
    ),
})

// INIT

// Opens empty from its tab, or on an issue's title with a related hit selected.
export const init = (query: string, maybeSelected: Option.Option<number>): Update.Return<Model, Message> => {
  const isAsked = query.length >= 2
  return {
    model: {
      query,
      searchSeq: 1,
      isSearching: isAsked,
      maybeShown: Option.none(),
      maybeSearchError: Option.none(),
      maybeSelected,
      itemSeq: 1,
      item: ItemState.Loading(),
    },
    commands: [
      ...(isAsked ? [Search({ seq: 1, query })] : []),
      ...Option.match(maybeSelected, { onNone: () => [], onSome: id => [FetchItem({ seq: 1, id })] }),
    ],
  }
}

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedQuery: ({ value }) => {
      const searchSeq = model.searchSeq + 1
      const isAsked = value.length >= 2
      const next = modifyFields(model, {
        query: () => value,
        searchSeq: () => searchSeq,
        isSearching: () => isAsked,
        maybeSearchError: () => Option.none(),
        maybeShown: shown => (value === '' ? Option.none() : shown),
      })
      return isAsked ? { model: next, commands: [Search({ seq: searchSeq, query: value })] } : { model: next }
    },

    SucceededSearch: ({ seq, query, hits }) =>
      seq === model.searchSeq
        ? {
            model: modifyFields(model, {
              isSearching: () => false,
              maybeShown: () => Option.some({ query, hits }),
            }),
          }
        : { model },

    FailedSearch: ({ seq, error }) =>
      seq === model.searchSeq
        ? { model: modifyFields(model, { isSearching: () => false, maybeSearchError: () => Option.some(error) }) }
        : { model },

    ClickedHit: ({ id }) => {
      if (Option.contains(model.maybeSelected, id)) {
        return { model }
      }
      const itemSeq = model.itemSeq + 1
      return {
        model: modifyFields(model, {
          maybeSelected: () => Option.some(id),
          itemSeq: () => itemSeq,
          item: () => ItemState.Loading(),
        }),
        commands: [FetchItem({ seq: itemSeq, id })],
      }
    },

    ClickedRetryItem: () =>
      Option.match(model.maybeSelected, {
        onNone: () => ({ model }),
        onSome: id => {
          const itemSeq = model.itemSeq + 1
          return { model: modifyFields(model, { itemSeq: () => itemSeq }), commands: [FetchItem({ seq: itemSeq, id })] }
        },
      }),

    SucceededFetchItem: ({ seq, item }) =>
      seq === model.itemSeq
        ? { model: modifyFields(model, { item: () => ItemState.Loaded({ maybeItem: Option.fromNullishOr(item) }) }) }
        : { model },

    FailedFetchItem: ({ seq, error }) =>
      seq === model.itemSeq ? { model: modifyFields(model, { item: () => ItemState.Failed({ error }) }) } : { model },
  })

// VIEW

const testId = (h: HtmlBuilder<Message>, id: string) => h.DataAttribute('testid', id)

const resultsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.query.length < 2) {
    return h.section([testId(h, 'results')], [h.p([], [`too short: ${model.query}`])])
  }
  const shown = Option.match(model.maybeSearchError, {
    onSome: error => (model.isSearching ? h.empty : h.p([], [`search failed: ${error}`])),
    onNone: () =>
      Option.match(model.maybeShown, {
        onNone: () => h.empty,
        onSome: ({ query, hits }) =>
          h.div([], [
            h.h2([], [`${hits.length} results for ${query}`]),
            h.ul(
              [],
              Array.map(hits, hit =>
                h.keyed('li')(
                  String(hit.id),
                  [testId(h, 'hit'), h.OnClick(Message.ClickedHit({ id: hit.id }))],
                  [`${Option.contains(model.maybeSelected, hit.id) ? '> ' : ''}${hit.name}`],
                ),
              ),
            ),
          ]),
      }),
  })
  return h.section([testId(h, 'results')], [model.isSearching ? h.p([], ['searching…']) : h.empty, shown])
}

const itemView = (model: Model, id: number, h: HtmlBuilder<Message>): Html =>
  h.section(
    [testId(h, 'item')],
    [
      ItemState.match(model.item, {
        Loading: () => h.p([], ['loading…']),
        Failed: ({ error }) =>
          h.div([], [
            h.p([], [`failed: ${error}`]),
            h.button([testId(h, 'retry-item'), h.OnClick(Message.ClickedRetryItem())], ['retry']),
          ]),
        Loaded: ({ maybeItem }) =>
          Option.match(maybeItem, {
            onNone: () => h.p([], [`item ${id} not found`]),
            onSome: item => h.article([], [h.h3([], [item.name]), h.p([], [item.blurb])]),
          }),
      }),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.main([], [
    h.input([testId(h, 'query'), h.Value(model.query), h.OnInput(value => Message.UpdatedQuery({ value }))]),
    model.query === '' ? h.empty : resultsView(model, h),
    Option.match(model.maybeSelected, {
      onNone: () => h.p([testId(h, 'item')], ['pick a result']),
      onSome: id => itemView(model, id, h),
    }),
  ]),
)
