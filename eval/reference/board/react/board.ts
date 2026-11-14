// The board as shown: the server's last answers (the query caches) with the writes still in the air laid over them.
import type { Card, Column, Item } from "./api";

export const COLUMNS: Column[] = ["todo", "doing", "done"];
export const COLUMN_NAME: Record<Column, string> = { todo: "To do", doing: "Doing", done: "Done" };
export const isColumn = (c: string): c is Column => (COLUMNS as string[]).includes(c);
/** Doing holds at most this many cards */
export const WIP_LIMIT = 3;

/** a card or item as the cache holds it; `addSeq` marks one this page added, by the seq of its add */
export type CachedCard = Card & { addSeq?: number };
export type CachedItem = Item & { addSeq?: number };

// writes in the air; `seq` orders all of the page's writes
export type Move = { seq: number; id: number; column: Column; index: number };
export type CardAdd = { seq: number; title: string };
export type Archiving = { seq: number; id: number };
export type Rename = { seq: number; id: number; title: string };
export type Toggle = { seq: number; cardId: number; itemId: number; done: boolean };
export type ItemAdd = { seq: number; cardId: number; text: string };

/**
 * Where an entry from the add with `seq` goes in a list: before the first entry that a later add put there (that add
 * answered first), else at the end. So entries keep the order their adds started in, guessed or answered.
 */
export function addSlot<T>(list: T[], seq: number, seqOf: (e: T) => number | undefined) {
  const i = list.findIndex(e => (seqOf(e) ?? -Infinity) > seq);
  return i < 0 ? list.length : i;
}

export type CardRow = { kind: "card"; card: CachedCard } | { kind: "adding"; seq: number; title: string };
const rowSeq = (r: CardRow) => (r.kind === "adding" ? r.seq : r.card.addSeq);

/**
 * The loaded columns with the moves, adds and archives in the air replayed over them in the order they started, so
 * each lands where it was made: a move at the position it was shown at, an add at the bottom of To do.
 */
export function layColumns(
  base: Record<Column, CachedCard[] | undefined>,
  moves: Move[],
  adds: CardAdd[],
  archiving: Archiving[],
): Record<Column, CardRow[] | undefined> {
  const cols = {} as Record<Column, CardRow[] | undefined>;
  for (const c of COLUMNS) cols[c] = base[c]?.map(card => ({ kind: "card", card }));
  const find = (id: number) => {
    for (const c of COLUMNS) {
      const i = cols[c]?.findIndex(r => r.kind === "card" && r.card.id === id) ?? -1;
      if (i >= 0) return { list: cols[c] as CardRow[], i };
    }
    return null;
  };
  type Op = ({ kind: "move" } & Move) | ({ kind: "add" } & CardAdd) | ({ kind: "archive" } & Archiving);
  const ops: Op[] = [
    ...moves.map(m => ({ kind: "move" as const, ...m })),
    ...adds.map(a => ({ kind: "add" as const, ...a })),
    ...archiving.map(a => ({ kind: "archive" as const, ...a })),
  ].sort((a, b) => a.seq - b.seq);
  for (const op of ops) {
    if (op.kind === "add") {
      const todo = cols.todo;
      if (todo) todo.splice(addSlot(todo, op.seq, rowSeq), 0, { kind: "adding", seq: op.seq, title: op.title });
      continue;
    }
    const at = find(op.id);
    if (!at) continue;
    if (op.kind === "archive") {
      at.list.splice(at.i, 1);
      continue;
    }
    const target = cols[op.column];
    if (!target) continue;
    const [row] = at.list.splice(at.i, 1);
    target.splice(Math.min(op.index, target.length), 0, row);
  }
  return cols;
}

/** the newest of the writes that `match` (writes are kept in the order they started) */
export function newest<T>(writes: T[], match: (w: T) => boolean): T | undefined {
  for (let i = writes.length - 1; i >= 0; i--) if (match(writes[i])) return writes[i];
  return undefined;
}

export type ItemRow = { kind: "item"; id: number; text: string; done: boolean } | { kind: "adding"; seq: number; text: string };

/** a card's checklist with its toggles (the newest one per item) and item adds in the air laid over it */
export function layItems(base: CachedItem[], toggles: Toggle[], adds: ItemAdd[]): ItemRow[] {
  type Entry = { row: ItemRow; seq: number | undefined };
  const list: Entry[] = base.map(item => ({
    row: { kind: "item", id: item.id, text: item.text, done: newest(toggles, t => t.itemId === item.id)?.done ?? item.done },
    seq: item.addSeq,
  }));
  for (const a of [...adds].sort((x, y) => x.seq - y.seq))
    list.splice(addSlot(list, a.seq, e => e.seq), 0, { row: { kind: "adding", seq: a.seq, text: a.text }, seq: a.seq });
  return list.map(e => e.row);
}

/** an item list's done and total, the adds in the air counted as not done */
export const countItems = (rows: ItemRow[]) => ({ done: rows.filter(r => r.kind === "item" && r.done).length, total: rows.length });

// the server's answers, written into the caches

/** the card answered at `column`/`index`, taken out of wherever the caches hold it */
export function placeCard(
  cols: Record<Column, CachedCard[] | undefined>,
  id: number,
  column: Column,
  index: number,
): Record<Column, CachedCard[] | undefined> {
  const card = COLUMNS.flatMap(c => cols[c] ?? []).find(x => x.id === id);
  const next = {} as Record<Column, CachedCard[] | undefined>;
  for (const c of COLUMNS) next[c] = cols[c]?.filter(x => x.id !== id);
  const target = next[column];
  if (card && target) target.splice(Math.min(index, target.length), 0, card);
  return next;
}
