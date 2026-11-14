import { Array, Option, Order, Schema, pipe } from 'effect'

// The board as shown: the server's last answers with the writes still in the air laid over them.

export const Column = Schema.Literals(['todo', 'doing', 'done'])
export type Column = typeof Column.Type

export const COLUMNS: ReadonlyArray<Column> = ['todo', 'doing', 'done']
export const COLUMN_NAME: Readonly<Record<Column, string>> = { todo: 'To do', doing: 'Doing', done: 'Done' }

/** Doing holds at most this many cards. */
export const WIP_LIMIT = 3

// A card or item as the server last answered it. `maybeAddSeq` marks one this page added, by the seq of its add.
export const Card = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  done: Schema.Number,
  total: Schema.Number,
  maybeAddSeq: Schema.Option(Schema.Number),
})
export type Card = typeof Card.Type

export const Item = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  done: Schema.Boolean,
  maybeAddSeq: Schema.Option(Schema.Number),
})
export type Item = typeof Item.Type

// Writes in the air. `seq` orders all of the page's writes.
export const Move = Schema.Struct({ seq: Schema.Number, id: Schema.Number, column: Column, index: Schema.Number })
export type Move = typeof Move.Type
export const CardAdd = Schema.Struct({ seq: Schema.Number, title: Schema.String })
export type CardAdd = typeof CardAdd.Type
export const Archiving = Schema.Struct({ seq: Schema.Number, id: Schema.Number })
export type Archiving = typeof Archiving.Type
export const Rename = Schema.Struct({ seq: Schema.Number, id: Schema.Number, title: Schema.String })
export type Rename = typeof Rename.Type
export const Toggle = Schema.Struct({ seq: Schema.Number, cardId: Schema.Number, itemId: Schema.Number, done: Schema.Boolean })
export type Toggle = typeof Toggle.Type
export const ItemAdd = Schema.Struct({ seq: Schema.Number, cardId: Schema.Number, text: Schema.String })
export type ItemAdd = typeof ItemAdd.Type

export type Columns<A> = Readonly<Record<Column, Option.Option<ReadonlyArray<A>>>>

/**
 * Where an entry from the add with `seq` goes in a list: before the first entry that a later add put there (that add
 * answered first), else at the end. So entries keep the order their adds started in, guessed or answered.
 */
export const addSlot = <A>(list: ReadonlyArray<A>, seq: number, seqOf: (entry: A) => Option.Option<number>): number =>
  Option.getOrElse(
    Array.findFirstIndex(list, entry => Option.exists(seqOf(entry), entrySeq => entrySeq > seq)),
    () => list.length,
  )

const bySeq = <A extends { readonly seq: number }>(): Order.Order<A> => Order.mapInput(Order.Number, (write: A) => write.seq)

/** the newest of the writes that `isMatch` (writes are kept in the order they started) */
export const newest = <A>(writes: ReadonlyArray<A>, isMatch: (write: A) => boolean): Option.Option<A> =>
  Array.findLast(writes, isMatch)

// THE COLUMNS

export type CardRow =
  | { readonly _tag: 'Card'; readonly card: Card }
  | { readonly _tag: 'Adding'; readonly seq: number; readonly title: string }

const rowSeq = (row: CardRow): Option.Option<number> =>
  row._tag === 'Adding' ? Option.some(row.seq) : row.card.maybeAddSeq

type Op =
  | ({ readonly _tag: 'Move' } & Move)
  | ({ readonly _tag: 'Add' } & CardAdd)
  | ({ readonly _tag: 'Archive' } & Archiving)

/**
 * The loaded columns with the moves, adds and archives in the air replayed over them in the order they started, so
 * each lands where it was made: a move at the position it was shown at, an add at the bottom of To do.
 */
export const layColumns = (
  base: Columns<Card>,
  moves: ReadonlyArray<Move>,
  adds: ReadonlyArray<CardAdd>,
  archiving: ReadonlyArray<Archiving>,
): Columns<CardRow> => {
  const lists: Record<Column, Array<CardRow> | undefined> = { todo: undefined, doing: undefined, done: undefined }
  for (const column of COLUMNS) {
    lists[column] = Option.getOrUndefined(
      Option.map(base[column], cards => cards.map((card): CardRow => ({ _tag: 'Card', card }))),
    )
  }
  const find = (id: number): { list: Array<CardRow>; index: number } | undefined => {
    for (const column of COLUMNS) {
      const list = lists[column]
      const index = list?.findIndex(row => row._tag === 'Card' && row.card.id === id) ?? -1
      if (list && index >= 0) {
        return { list, index }
      }
    }
    return undefined
  }
  const ops: ReadonlyArray<Op> = pipe(
    [
      ...moves.map((move): Op => ({ _tag: 'Move', ...move })),
      ...adds.map((add): Op => ({ _tag: 'Add', ...add })),
      ...archiving.map((archive): Op => ({ _tag: 'Archive', ...archive })),
    ],
    Array.sort(bySeq<Op>()),
  )
  for (const op of ops) {
    if (op._tag === 'Add') {
      const todo = lists.todo
      if (todo) {
        todo.splice(addSlot(todo, op.seq, rowSeq), 0, { _tag: 'Adding', seq: op.seq, title: op.title })
      }
      continue
    }
    const at = find(op.id)
    if (!at) {
      continue
    }
    if (op._tag === 'Archive') {
      at.list.splice(at.index, 1)
      continue
    }
    const target = lists[op.column]
    if (!target) {
      continue
    }
    const [row] = at.list.splice(at.index, 1)
    if (row) {
      target.splice(Math.min(op.index, target.length), 0, row)
    }
  }
  return {
    todo: Option.fromUndefinedOr(lists.todo),
    doing: Option.fromUndefinedOr(lists.doing),
    done: Option.fromUndefinedOr(lists.done),
  }
}

// THE CHECKLIST

export type ItemRow =
  | { readonly _tag: 'Item'; readonly id: number; readonly text: string; readonly done: boolean }
  | { readonly _tag: 'Adding'; readonly seq: number; readonly text: string }

/** a card's checklist with its toggles (the newest one per item) and item adds in the air laid over it */
export const layItems = (
  base: ReadonlyArray<Item>,
  toggles: ReadonlyArray<Toggle>,
  adds: ReadonlyArray<ItemAdd>,
): ReadonlyArray<ItemRow> => {
  type Entry = { readonly row: ItemRow; readonly maybeSeq: Option.Option<number> }
  const entries: Array<Entry> = base.map(item => ({
    row: {
      _tag: 'Item',
      id: item.id,
      text: item.text,
      done: Option.match(newest(toggles, toggle => toggle.itemId === item.id), {
        onNone: () => item.done,
        onSome: toggle => toggle.done,
      }),
    },
    maybeSeq: item.maybeAddSeq,
  }))
  for (const add of Array.sort(adds, bySeq<ItemAdd>())) {
    entries.splice(addSlot(entries, add.seq, entry => entry.maybeSeq), 0, {
      row: { _tag: 'Adding', seq: add.seq, text: add.text },
      maybeSeq: Option.some(add.seq),
    })
  }
  return entries.map(entry => entry.row)
}

/** an item list's done and total, the adds in the air counted as not done */
export const countItems = (rows: ReadonlyArray<ItemRow>): { done: number; total: number } => ({
  done: rows.filter(row => row._tag === 'Item' && row.done).length,
  total: rows.length,
})

// THE SERVER'S ANSWERS

/** the card answered at `column`/`index`, taken out of wherever the loaded columns hold it */
export const placeCard = (columns: Columns<Card>, id: number, column: Column, index: number): Columns<Card> => {
  const maybeCard = pipe(
    COLUMNS,
    Array.flatMap(c => Option.getOrElse(columns[c], () => [])),
    Array.findFirst(card => card.id === id),
  )
  const without = mapCards(columns, cards => cards.filter(card => card.id !== id))
  return Option.match(maybeCard, {
    onNone: () => without,
    onSome: card => ({
      ...without,
      [column]: Option.map(without[column], cards => {
        const next = [...cards]
        next.splice(Math.min(index, next.length), 0, card)
        return next
      }),
    }),
  })
}

export const mapCards = (
  columns: Columns<Card>,
  f: (cards: ReadonlyArray<Card>) => ReadonlyArray<Card>,
): Columns<Card> => ({
  todo: Option.map(columns.todo, f),
  doing: Option.map(columns.doing, f),
  done: Option.map(columns.done, f),
})
