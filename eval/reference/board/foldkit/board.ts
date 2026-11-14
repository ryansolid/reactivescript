import { Array, Effect, Option, Schema, pipe } from 'effect'
import { Command, Submodel, type Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as Api from './api'
import {
  Archiving,
  COLUMNS,
  COLUMN_NAME,
  Card,
  CardAdd,
  type CardRow,
  Column,
  type Columns,
  Item,
  ItemAdd,
  type ItemRow,
  Move,
  Rename,
  Toggle,
  WIP_LIMIT,
  addSlot,
  countItems,
  layColumns,
  layItems,
  mapCards,
  newest,
  placeCard,
} from './layout'
import { request } from './request'

// The board page. Its model lives as long as one visit of the page: what it loaded, the writes it started that are
// still in the air, and its inputs and errors.

// MODEL

const ServerCard = Schema.Struct({ id: Schema.Number, title: Schema.String, done: Schema.Number, total: Schema.Number })
const ServerItem = Schema.Struct({ id: Schema.Number, text: Schema.String, done: Schema.Boolean })

export const ColumnState = defineTaggedUnion({
  Loading: {},
  Loaded: { cards: Schema.Array(Card) },
  Failed: { error: Schema.String },
})
type ColumnState = typeof ColumnState.Type

const ColumnStates = Schema.Struct({ todo: ColumnState, doing: ColumnState, done: ColumnState })
type ColumnStates = typeof ColumnStates.Type

export const ChecklistState = defineTaggedUnion({
  Loading: {},
  Loaded: { items: Schema.Array(Item) },
  Failed: { error: Schema.String },
})
type ChecklistState = typeof ChecklistState.Type

// Every checklist the page asked for stays as last answered for the page's life, so a card whose checklist is known
// counts its items as the checklist shows them, writes in the air included.
const Checklist = Schema.Struct({ cardId: Schema.Number, state: ChecklistState })

// An error that belongs to one selection of a card (`visit` counts selections): selecting a card, even the same one
// again, leaves it behind, and a write that answers after its selection was left reports nothing.
const VisitError = Schema.Struct({ visit: Schema.Number, message: Schema.String })
type VisitError = typeof VisitError.Type

export const Model = Schema.Struct({
  columns: ColumnStates,
  checklists: Schema.Array(Checklist),
  maybeSelected: Schema.Option(Schema.Number),
  visit: Schema.Number,
  newCard: Schema.String,
  titleInput: Schema.String,
  itemInput: Schema.String,
  seq: Schema.Number,
  moves: Schema.Array(Move),
  cardAdds: Schema.Array(CardAdd),
  archiving: Schema.Array(Archiving),
  renames: Schema.Array(Rename),
  toggles: Schema.Array(Toggle),
  itemAdds: Schema.Array(ItemAdd),
  maybeMoveError: Schema.Option(Schema.String),
  maybeAddError: Schema.Option(Schema.String),
  maybeArchiveError: Schema.Option(Schema.String),
  maybeRenameError: Schema.Option(VisitError),
  maybeItemError: Schema.Option(VisitError),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchCards: { column: Column, cards: Schema.Array(ServerCard) },
  FailedFetchCards: { column: Column, error: Schema.String },
  ClickedRetry: { column: Column },
  ClickedMove: { id: Schema.Number, column: Column, index: Schema.Number },
  SucceededMove: { seq: Schema.Number, id: Schema.Number, column: Column, index: Schema.Number },
  FailedMove: { seq: Schema.Number, error: Schema.String },
  UpdatedNewCard: { value: Schema.String },
  ClickedAddCard: {},
  SucceededAddCard: { seq: Schema.Number, id: Schema.Number, title: Schema.String },
  FailedAddCard: { seq: Schema.Number, error: Schema.String },
  ClickedCard: { id: Schema.Number },
  UpdatedTitleInput: { value: Schema.String },
  ClickedRename: {},
  SucceededRename: { seq: Schema.Number, id: Schema.Number, title: Schema.String },
  FailedRename: { seq: Schema.Number, visit: Schema.Number, error: Schema.String },
  ClickedArchive: {},
  SucceededArchive: { seq: Schema.Number, id: Schema.Number },
  FailedArchive: { seq: Schema.Number, error: Schema.String },
  SucceededFetchChecklist: { cardId: Schema.Number, items: Schema.Array(ServerItem) },
  FailedFetchChecklist: { cardId: Schema.Number, error: Schema.String },
  ClickedToggle: { itemId: Schema.Number, done: Schema.Boolean },
  SucceededToggle: { seq: Schema.Number, cardId: Schema.Number, itemId: Schema.Number, done: Schema.Boolean },
  FailedToggle: { seq: Schema.Number, visit: Schema.Number, error: Schema.String },
  UpdatedItemInput: { value: Schema.String },
  ClickedAddItem: {},
  SucceededAddItem: { seq: Schema.Number, cardId: Schema.Number, item: ServerItem },
  FailedAddItem: { seq: Schema.Number, visit: Schema.Number, error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const FetchCards = Command.define('FetchCards', {
  args: { column: Column },
  messages: [Message.SucceededFetchCards, Message.FailedFetchCards],
  execute: ({ column }) =>
    request(() => Api.fetchCards(column)).pipe(
      Effect.map(cards => Message.SucceededFetchCards({ column, cards })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchCards({ column, error }))),
    ),
})

const isColumn = Schema.is(Column)

const MoveCard = Command.define('MoveCard', {
  args: { seq: Schema.Number, id: Schema.Number, column: Column, index: Schema.Number },
  messages: [Message.SucceededMove, Message.FailedMove],
  execute: ({ seq, id, column, index }) =>
    request(() => Api.moveCard(id, column, index)).pipe(
      Effect.map(answer =>
        Message.SucceededMove({
          seq,
          id: answer.id,
          column: isColumn(answer.column) ? answer.column : column,
          index: answer.index,
        }),
      ),
      Effect.catch(error => Effect.succeed(Message.FailedMove({ seq, error }))),
    ),
})

const AddCard = Command.define('AddCard', {
  args: { seq: Schema.Number, title: Schema.String },
  messages: [Message.SucceededAddCard, Message.FailedAddCard],
  execute: ({ seq, title }) =>
    request(() => Api.addCard('todo', title)).pipe(
      Effect.map(answer => Message.SucceededAddCard({ seq, id: answer.id, title: answer.title })),
      Effect.catch(error => Effect.succeed(Message.FailedAddCard({ seq, error }))),
    ),
})

const RenameCard = Command.define('RenameCard', {
  args: { seq: Schema.Number, visit: Schema.Number, id: Schema.Number, title: Schema.String },
  messages: [Message.SucceededRename, Message.FailedRename],
  execute: ({ seq, visit, id, title }) =>
    request(() => Api.renameCard(id, title)).pipe(
      Effect.map(answer => Message.SucceededRename({ seq, id: answer.id, title: answer.title })),
      Effect.catch(error => Effect.succeed(Message.FailedRename({ seq, visit, error }))),
    ),
})

const ArchiveCard = Command.define('ArchiveCard', {
  args: { seq: Schema.Number, id: Schema.Number },
  messages: [Message.SucceededArchive, Message.FailedArchive],
  execute: ({ seq, id }) =>
    request(() => Api.archiveCard(id)).pipe(
      Effect.map(answer => Message.SucceededArchive({ seq, id: answer.id })),
      Effect.catch(error => Effect.succeed(Message.FailedArchive({ seq, error }))),
    ),
})

const FetchChecklist = Command.define('FetchChecklist', {
  args: { cardId: Schema.Number },
  messages: [Message.SucceededFetchChecklist, Message.FailedFetchChecklist],
  execute: ({ cardId }) =>
    request(() => Api.fetchChecklist(cardId)).pipe(
      Effect.map(items => Message.SucceededFetchChecklist({ cardId, items })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchChecklist({ cardId, error }))),
    ),
})

const ToggleItem = Command.define('ToggleItem', {
  args: { seq: Schema.Number, visit: Schema.Number, cardId: Schema.Number, itemId: Schema.Number, done: Schema.Boolean },
  messages: [Message.SucceededToggle, Message.FailedToggle],
  execute: ({ seq, visit, cardId, itemId, done }) =>
    request(() => Api.toggleItem(cardId, itemId, done)).pipe(
      Effect.map(answer => Message.SucceededToggle({ seq, cardId, itemId: answer.id, done: answer.done })),
      Effect.catch(error => Effect.succeed(Message.FailedToggle({ seq, visit, error }))),
    ),
})

const AddItem = Command.define('AddItem', {
  args: { seq: Schema.Number, visit: Schema.Number, cardId: Schema.Number, text: Schema.String },
  messages: [Message.SucceededAddItem, Message.FailedAddItem],
  execute: ({ seq, visit, cardId, text }) =>
    request(() => Api.addItem(cardId, text)).pipe(
      Effect.map(item => Message.SucceededAddItem({ seq, cardId, item })),
      Effect.catch(error => Effect.succeed(Message.FailedAddItem({ seq, visit, error }))),
    ),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: {
    columns: { todo: ColumnState.Loading(), doing: ColumnState.Loading(), done: ColumnState.Loading() },
    checklists: [],
    maybeSelected: Option.none(),
    visit: 0,
    newCard: '',
    titleInput: '',
    itemInput: '',
    seq: 1,
    moves: [],
    cardAdds: [],
    archiving: [],
    renames: [],
    toggles: [],
    itemAdds: [],
    maybeMoveError: Option.none(),
    maybeAddError: Option.none(),
    maybeArchiveError: Option.none(),
    maybeRenameError: Option.none(),
    maybeItemError: Option.none(),
  },
  commands: COLUMNS.map(column => FetchCards({ column })),
})

// WHAT THE PAGE SHOWS

/** a card as the board shows it, or one being added (no id yet) */
type ShownRow =
  | { readonly _tag: 'Card'; readonly id: number; readonly title: string; readonly done: number; readonly total: number }
  | { readonly _tag: 'Adding'; readonly seq: number; readonly title: string }

const loadedCards = (columns: ColumnStates): Columns<Card> => ({
  todo: columns.todo._tag === 'Loaded' ? Option.some(columns.todo.cards) : Option.none(),
  doing: columns.doing._tag === 'Loaded' ? Option.some(columns.doing.cards) : Option.none(),
  done: columns.done._tag === 'Loaded' ? Option.some(columns.done.cards) : Option.none(),
})

const findChecklist = (model: Model, cardId: number): Option.Option<ChecklistState> =>
  pipe(
    model.checklists,
    Array.findFirst(checklist => checklist.cardId === cardId),
    Option.map(checklist => checklist.state),
  )

/** the checklist of `cardId` as shown, once it has loaded */
const shownItems = (model: Model, cardId: number): Option.Option<ReadonlyArray<ItemRow>> =>
  pipe(
    findChecklist(model, cardId),
    Option.flatMap(state => (state._tag === 'Loaded' ? Option.some(state.items) : Option.none())),
    Option.map(items =>
      layItems(
        items,
        Array.filter(model.toggles, toggle => toggle.cardId === cardId),
        Array.filter(model.itemAdds, add => add.cardId === cardId),
      ),
    ),
  )

const shownRow =
  (model: Model) =>
  (row: CardRow): ShownRow => {
    if (row._tag === 'Adding') {
      return row
    }
    const { card } = row
    const { done, total } = Option.match(shownItems(model, card.id), {
      onNone: () => card,
      onSome: countItems,
    })
    const title = Option.match(newest(model.renames, rename => rename.id === card.id), {
      onNone: () => card.title,
      onSome: rename => rename.title,
    })
    return { _tag: 'Card', id: card.id, title, done, total }
  }

const shownColumns = (model: Model): Columns<ShownRow> => {
  const laid = layColumns(loadedCards(model.columns), model.moves, model.cardAdds, model.archiving)
  const toShown = Option.map((rows: ReadonlyArray<CardRow>) => rows.map(shownRow(model)))
  return { todo: toShown(laid.todo), doing: toShown(laid.doing), done: toShown(laid.done) }
}

type ShownCard = { readonly id: number; readonly title: string; readonly column: Column }

/** the selected card as the board shows it, while it is on the board */
const selectedCard = (model: Model, shown: Columns<ShownRow>): Option.Option<ShownCard> =>
  Option.flatMap(model.maybeSelected, id =>
    pipe(
      COLUMNS,
      Array.findFirst(column =>
        pipe(
          shown[column],
          Option.flatMap(Array.findFirst(row => row._tag === 'Card' && row.id === id)),
          Option.flatMap(row => (row._tag === 'Card' ? Option.some({ id, title: row.title, column }) : Option.none())),
        ),
      ),
    ),
  )

const sizeOf = (shown: Columns<ShownRow>, column: Column): number =>
  Option.match(shown[column], { onNone: () => 0, onSome: rows => rows.length })

/** whether a card may move into `target` from another column: it has loaded, and Doing is under its limit */
const canEnter = (shown: Columns<ShownRow>, target: Column): boolean =>
  Option.match(shown[target], {
    onNone: () => false,
    onSome: rows => target !== 'doing' || rows.length < WIP_LIMIT,
  })

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const dropSettled =
  (seq: number) =>
  <A extends { readonly seq: number }>(writes: ReadonlyArray<A>): ReadonlyArray<A> =>
    Array.filter(writes, write => write.seq !== seq)

// The server's answers, written into what the page loaded.

const withCards = (model: Model, f: (cards: Columns<Card>) => Columns<Card>): Model => {
  const next = f(loadedCards(model.columns))
  const write = (column: Column): ColumnState =>
    Option.match(next[column], {
      onNone: () => model.columns[column],
      onSome: cards => ColumnState.Loaded({ cards }),
    })
  return modifyFields(model, { columns: () => ({ todo: write('todo'), doing: write('doing'), done: write('done') }) })
}

const withCardPatch = (model: Model, id: number, f: (card: Card) => Card): Model =>
  withCards(model, columns => mapCards(columns, Array.map(card => (card.id === id ? f(card) : card))))

const withChecklist = (model: Model, cardId: number, f: (state: Option.Option<ChecklistState>) => ChecklistState): Model =>
  modifyFields(model, {
    checklists: checklists => [
      ...Array.filter(checklists, checklist => checklist.cardId !== cardId),
      { cardId, state: f(findChecklist(model, cardId)) },
    ],
  })

const withItems = (model: Model, cardId: number, f: (items: ReadonlyArray<Item>) => ReadonlyArray<Item>): Model =>
  Option.match(findChecklist(model, cardId), {
    onNone: () => model,
    onSome: state =>
      state._tag === 'Loaded' ? withChecklist(model, cardId, () => ChecklistState.Loaded({ items: f(state.items) })) : model,
  })

const select = (model: Model, id: number): UpdateReturn => {
  const selected = modifyFields(model, {
    maybeSelected: () => Option.some(id),
    visit: visit => visit + 1,
    titleInput: () => '',
    itemInput: () => '',
  })
  const isKnown = Option.exists(findChecklist(model, id), state => state._tag !== 'Failed')
  return isKnown
    ? { model: selected }
    : {
        model: withChecklist(selected, id, () => ChecklistState.Loading()),
        commands: [FetchChecklist({ cardId: id })],
      }
}

const visitError = (model: Model, visit: number, message: string) => (current: Option.Option<VisitError>) =>
  visit === model.visit ? Option.some({ visit, message }) : current

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchCards: ({ column, cards }) =>
      model.columns[column]._tag === 'Loading'
        ? {
            model: modifyFields(model, {
              columns: columns => ({
                ...columns,
                [column]: ColumnState.Loaded({ cards: cards.map(card => ({ ...card, maybeAddSeq: Option.none() })) }),
              }),
            }),
          }
        : { model },

    FailedFetchCards: ({ column, error }) =>
      model.columns[column]._tag === 'Loading'
        ? { model: modifyFields(model, { columns: columns => ({ ...columns, [column]: ColumnState.Failed({ error }) }) }) }
        : { model },

    ClickedRetry: ({ column }) =>
      model.columns[column]._tag === 'Failed'
        ? {
            model: modifyFields(model, { columns: columns => ({ ...columns, [column]: ColumnState.Loading() }) }),
            commands: [FetchCards({ column })],
          }
        : { model },

    ClickedMove: ({ id, column, index }) => ({
      model: modifyFields(model, {
        seq: seq => seq + 1,
        maybeMoveError: () => Option.none(),
        moves: Array.append({ seq: model.seq, id, column, index }),
      }),
      commands: [MoveCard({ seq: model.seq, id, column, index })],
    }),

    SucceededMove: ({ seq, id, column, index }) => ({
      model: withCards(modifyFields(model, { moves: dropSettled(seq) }), columns => placeCard(columns, id, column, index)),
    }),

    FailedMove: ({ seq, error }) => ({
      model: modifyFields(model, { moves: dropSettled(seq), maybeMoveError: () => Option.some(error) }),
    }),

    UpdatedNewCard: ({ value }) => ({ model: modifyFields(model, { newCard: () => value }) }),

    ClickedAddCard: () => {
      const title = model.newCard
      if (title === '' || model.columns.todo._tag !== 'Loaded') {
        return { model }
      }
      return {
        model: modifyFields(model, {
          seq: seq => seq + 1,
          newCard: () => '',
          maybeAddError: () => Option.none(),
          cardAdds: Array.append({ seq: model.seq, title }),
        }),
        commands: [AddCard({ seq: model.seq, title })],
      }
    },

    SucceededAddCard: ({ seq, id, title }) => ({
      model: withCards(modifyFields(model, { cardAdds: dropSettled(seq) }), columns => ({
        ...columns,
        todo: Option.map(columns.todo, cards => {
          if (Array.some(cards, card => card.id === id)) {
            return cards
          }
          const next = [...cards]
          next.splice(addSlot(cards, seq, card => card.maybeAddSeq), 0, {
            id,
            title,
            done: 0,
            total: 0,
            maybeAddSeq: Option.some(seq),
          })
          return next
        }),
      })),
    }),

    FailedAddCard: ({ seq, error }) => ({
      model: modifyFields(model, { cardAdds: dropSettled(seq), maybeAddError: () => Option.some(error) }),
    }),

    ClickedCard: ({ id }) => select(model, id),

    UpdatedTitleInput: ({ value }) => ({ model: modifyFields(model, { titleInput: () => value }) }),

    ClickedRename: () =>
      Option.match(selectedCard(model, shownColumns(model)), {
        onNone: () => ({ model }),
        onSome: ({ id }) =>
          model.titleInput === ''
            ? { model }
            : {
                model: modifyFields(model, {
                  seq: seq => seq + 1,
                  maybeRenameError: () => Option.none(),
                  renames: Array.append({ seq: model.seq, id, title: model.titleInput }),
                }),
                commands: [RenameCard({ seq: model.seq, visit: model.visit, id, title: model.titleInput })],
              },
      }),

    SucceededRename: ({ seq, id, title }) => ({
      model: withCardPatch(modifyFields(model, { renames: dropSettled(seq) }), id, card => ({ ...card, title })),
    }),

    FailedRename: ({ seq, visit, error }) => ({
      model: modifyFields(model, { renames: dropSettled(seq), maybeRenameError: visitError(model, visit, error) }),
    }),

    ClickedArchive: () =>
      Option.match(selectedCard(model, shownColumns(model)), {
        onNone: () => ({ model }),
        onSome: ({ id }) => ({
          model: modifyFields(model, {
            seq: seq => seq + 1,
            maybeSelected: () => Option.none(),
            maybeArchiveError: () => Option.none(),
            archiving: Array.append({ seq: model.seq, id }),
          }),
          commands: [ArchiveCard({ seq: model.seq, id })],
        }),
      }),

    SucceededArchive: ({ seq, id }) => ({
      model: withCards(modifyFields(model, { archiving: dropSettled(seq) }), columns =>
        mapCards(columns, Array.filter(card => card.id !== id)),
      ),
    }),

    FailedArchive: ({ seq, error }) => ({
      model: modifyFields(model, { archiving: dropSettled(seq), maybeArchiveError: () => Option.some(error) }),
    }),

    SucceededFetchChecklist: ({ cardId, items }) =>
      Option.exists(findChecklist(model, cardId), state => state._tag === 'Loading')
        ? {
            model: withChecklist(model, cardId, () =>
              ChecklistState.Loaded({ items: items.map(item => ({ ...item, maybeAddSeq: Option.none() })) }),
            ),
          }
        : { model },

    FailedFetchChecklist: ({ cardId, error }) =>
      Option.exists(findChecklist(model, cardId), state => state._tag === 'Loading')
        ? { model: withChecklist(model, cardId, () => ChecklistState.Failed({ error })) }
        : { model },

    ClickedToggle: ({ itemId, done }) =>
      Option.match(selectedCard(model, shownColumns(model)), {
        onNone: () => ({ model }),
        onSome: ({ id: cardId }) => ({
          model: modifyFields(model, {
            seq: seq => seq + 1,
            maybeItemError: () => Option.none(),
            toggles: Array.append({ seq: model.seq, cardId, itemId, done }),
          }),
          commands: [ToggleItem({ seq: model.seq, visit: model.visit, cardId, itemId, done })],
        }),
      }),

    SucceededToggle: ({ seq, cardId, itemId, done }) => ({
      model: withItems(modifyFields(model, { toggles: dropSettled(seq) }), cardId, items =>
        items.map(item => (item.id === itemId ? { ...item, done } : item)),
      ),
    }),

    FailedToggle: ({ seq, visit, error }) => ({
      model: modifyFields(model, { toggles: dropSettled(seq), maybeItemError: visitError(model, visit, error) }),
    }),

    UpdatedItemInput: ({ value }) => ({ model: modifyFields(model, { itemInput: () => value }) }),

    ClickedAddItem: () =>
      Option.match(selectedCard(model, shownColumns(model)), {
        onNone: () => ({ model }),
        onSome: ({ id: cardId }) => {
          const text = model.itemInput
          if (text === '' || Option.isNone(shownItems(model, cardId))) {
            return { model }
          }
          return {
            model: modifyFields(model, {
              seq: seq => seq + 1,
              itemInput: () => '',
              maybeItemError: () => Option.none(),
              itemAdds: Array.append({ seq: model.seq, cardId, text }),
            }),
            commands: [AddItem({ seq: model.seq, visit: model.visit, cardId, text })],
          }
        },
      }),

    SucceededAddItem: ({ seq, cardId, item }) => ({
      model: withItems(modifyFields(model, { itemAdds: dropSettled(seq) }), cardId, items => {
        if (Array.some(items, existing => existing.id === item.id)) {
          return items
        }
        const next = [...items]
        next.splice(addSlot(items, seq, existing => existing.maybeAddSeq), 0, { ...item, maybeAddSeq: Option.some(seq) })
        return next
      }),
    }),

    FailedAddItem: ({ seq, visit, error }) => ({
      model: modifyFields(model, { itemAdds: dropSettled(seq), maybeItemError: visitError(model, visit, error) }),
    }),
  })

// VIEW

const testId = (h: HtmlBuilder<Message>, id: string) => h.DataAttribute('testid', id)

const errorLine = (maybeError: Option.Option<string>, id: string, prefix: string, h: HtmlBuilder<Message>): Html =>
  Option.match(maybeError, { onNone: () => h.empty, onSome: error => h.p([testId(h, id)], [`${prefix}${error}`]) })

const visitErrorLine = (model: Model, maybeError: Option.Option<VisitError>, prefix: string, h: HtmlBuilder<Message>): Html =>
  pipe(
    maybeError,
    Option.filter(error => error.visit === model.visit),
    Option.match({ onNone: () => h.empty, onSome: error => h.p([], [`${prefix}${error.message}`]) }),
  )

const moveButton = (
  h: HtmlBuilder<Message>,
  direction: string,
  isDisabled: boolean,
  move: { id: number; column: Column; index: number },
): Html =>
  h.button([testId(h, direction), h.Disabled(isDisabled), h.OnClick(Message.ClickedMove(move))], [direction])

const cardRow = (
  model: Model,
  shown: Columns<ShownRow>,
  column: Column,
  rows: ReadonlyArray<ShownRow>,
  row: ShownRow,
  index: number,
  h: HtmlBuilder<Message>,
): Html => {
  if (row._tag === 'Adding') {
    return h.keyed('li')(`adding-${row.seq}`, [], [h.span([testId(h, 'card')], [`${row.title} (adding…)`])])
  }
  const at = COLUMNS.indexOf(column)
  const maybeLeft = Array.get(COLUMNS, at - 1)
  const maybeRight = Array.get(COLUMNS, at + 1)
  const across = (direction: string, maybeTarget: Option.Option<Column>): Html =>
    Option.match(maybeTarget, {
      onNone: () => h.empty,
      onSome: target =>
        moveButton(h, direction, !canEnter(shown, target), { id: row.id, column: target, index: sizeOf(shown, target) }),
    })
  return h.keyed('li')(`card-${row.id}`, [], [
    h.button(
      [
        testId(h, 'card'),
        h.AriaPressed(String(Option.contains(model.maybeSelected, row.id))),
        h.OnClick(Message.ClickedCard({ id: row.id })),
      ],
      [`#${row.id} ${row.title} · ${row.done}/${row.total}`],
    ),
    ' ',
    across('left', maybeLeft),
    across('right', maybeRight),
    index > 0 ? moveButton(h, 'up', false, { id: row.id, column, index: index - 1 }) : h.empty,
    index < rows.length - 1 ? moveButton(h, 'down', false, { id: row.id, column, index: index + 1 }) : h.empty,
  ])
}

const addCardForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div([], [
    h.input([
      testId(h, 'new-card'),
      h.Value(model.newCard),
      h.Placeholder('new card'),
      h.OnInput(value => Message.UpdatedNewCard({ value })),
    ]),
    ' ',
    h.button(
      [testId(h, 'add-card'), h.Disabled(model.columns.todo._tag !== 'Loaded'), h.OnClick(Message.ClickedAddCard())],
      ['add'],
    ),
    errorLine(model.maybeAddError, 'add-error', 'add error: ', h),
  ])

const columnView = (model: Model, shown: Columns<ShownRow>, column: Column, h: HtmlBuilder<Message>): Html => {
  const maybeRows = shown[column]
  const body = Option.match(maybeRows, {
    onSome: rows => h.ul([], rows.map((row, index) => cardRow(model, shown, column, rows, row, index, h))),
    onNone: () =>
      ColumnState.match(model.columns[column], {
        Loading: () => h.p([], ['loading']),
        Loaded: () => h.p([], ['loading']),
        Failed: ({ error }) =>
          h.p([], [
            `error: ${error} `,
            h.button([testId(h, `retry-${column}`), h.OnClick(Message.ClickedRetry({ column }))], ['retry']),
          ]),
      }),
  })
  return h.section([testId(h, `col-${column}`), h.Style({ minWidth: '14rem' })], [
    h.h2([testId(h, `head-${column}`)], [
      Option.match(maybeRows, {
        onNone: () => COLUMN_NAME[column],
        onSome: rows => `${COLUMN_NAME[column]} (${rows.length})`,
      }),
    ]),
    body,
    column === 'todo' ? addCardForm(model, h) : h.empty,
  ])
}

const itemRow = (row: ItemRow, h: HtmlBuilder<Message>): Html =>
  row._tag === 'Adding'
    ? h.keyed('li')(`adding-${row.seq}`, [], [h.span([testId(h, 'item')], [`[ ] ${row.text} (adding…)`])])
    : h.keyed('li')(`item-${row.id}`, [], [
        h.span([testId(h, 'item')], [`[${row.done ? 'x' : ' '}] ${row.text}`]),
        ' ',
        h.button([testId(h, 'toggle'), h.OnClick(Message.ClickedToggle({ itemId: row.id, done: !row.done }))], ['toggle']),
      ])

const checklistView = (model: Model, cardId: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [testId(h, 'checklist')],
    [
      Option.match(shownItems(model, cardId), {
        onSome: rows => {
          const { done, total } = countItems(rows)
          return h.div([], [
            h.ul([], rows.map(row => itemRow(row, h))),
            h.p([testId(h, 'progress')], [`${done}/${total} done`]),
          ])
        },
        onNone: () =>
          Option.match(findChecklist(model, cardId), {
            onNone: () => h.p([], ['loading checklist']),
            onSome: state =>
              ChecklistState.match(state, {
                Loading: () => h.p([], ['loading checklist']),
                Loaded: () => h.p([], ['loading checklist']),
                Failed: ({ error }) => h.p([], [`checklist error: ${error}`]),
              }),
          }),
      }),
    ],
  )

const detailView = (model: Model, card: ShownCard, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.h2([], [`#${card.id} ${card.title}`]),
  h.p([], [`in ${COLUMN_NAME[card.column]}`]),
  h.div([], [
    h.input([
      testId(h, 'title-input'),
      h.Value(model.titleInput),
      h.Placeholder('new title'),
      h.OnInput(value => Message.UpdatedTitleInput({ value })),
    ]),
    ' ',
    h.button([testId(h, 'rename'), h.OnClick(Message.ClickedRename())], ['rename']),
    ' ',
    h.button([testId(h, 'archive'), h.OnClick(Message.ClickedArchive())], ['archive']),
  ]),
  visitErrorLine(model, model.maybeRenameError, 'rename error: ', h),
  checklistView(model, card.id, h),
  h.div([], [
    h.input([
      testId(h, 'item-input'),
      h.Value(model.itemInput),
      h.Placeholder('new item'),
      h.OnInput(value => Message.UpdatedItemInput({ value })),
    ]),
    ' ',
    h.button(
      [
        testId(h, 'add-item'),
        h.Disabled(Option.isNone(shownItems(model, card.id))),
        h.OnClick(Message.ClickedAddItem()),
      ],
      ['add item'],
    ),
  ]),
  visitErrorLine(model, model.maybeItemError, 'item error: ', h),
]

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const shown = shownColumns(model)
  return h.div([], [
    h.div([h.Style({ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' })], [
      ...COLUMNS.map(column => columnView(model, shown, column, h)),
      h.section(
        [testId(h, 'detail'), h.Style({ minWidth: '16rem' })],
        Option.match(selectedCard(model, shown), {
          onNone: () => [h.p([], ['select a card'])],
          onSome: card => detailView(model, card, h),
        }),
      ),
    ]),
    errorLine(model.maybeMoveError, 'move-error', 'move error: ', h),
    errorLine(model.maybeArchiveError, 'archive-error', 'archive error: ', h),
  ])
})
