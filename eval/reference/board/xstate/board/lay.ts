// The board as shown: the server's last answers with the writes still in the air laid over them.
import type { Card, Column, Item } from "../api";

export const COLUMNS: Column[] = ["todo", "doing", "done"];
export const COLUMN_NAME: Record<Column, string> = { todo: "To do", doing: "Doing", done: "Done" };
export const isColumn = (c: string): c is Column => (COLUMNS as string[]).includes(c);
/** Doing holds at most this many cards */
export const WIP_LIMIT = 3;

/** a card or item as the page last had it from the server; `addSeq` marks one this page added, by its add's seq */
export type KnownCard = Card & { addSeq?: number };
export type KnownItem = Item & { addSeq?: number };
export type Columns = Record<Column, KnownCard[] | null>;

export type WriteRequest =
  | { kind: "move"; id: number; column: Column; index: number }
  | { kind: "addCard"; title: string }
  | { kind: "archive"; id: number }
  | { kind: "rename"; id: number; title: string }
  | { kind: "toggle"; cardId: number; itemId: number; done: boolean }
  | { kind: "addItem"; cardId: number; text: string };

/** A write in flight. `seq` orders all of the page's writes by when they started; `visit` is the selection it was made in. */
export type Write = WriteRequest & { seq: number; visit: number };
type WriteOf<K extends Write["kind"]> = Extract<Write, { kind: K }>;
export const writesOf = <K extends Write["kind"]>(writes: Write[], kind: K) => writes.filter((w): w is WriteOf<K> => w.kind === kind);

/** the newest of the writes that `match` (writes are kept in the order they started) */
export function newest<T>(writes: T[], match: (w: T) => boolean): T | undefined {
  for (let i = writes.length - 1; i >= 0; i--) if (match(writes[i])) return writes[i];
  return undefined;
}

/**
 * Where an entry from the add with `seq` goes in a list: before the first entry that a later add put there (that add
 * answered first), else at the end. So entries keep the order their adds started in, guessed or answered.
 */
export function addSlot<T>(list: T[], seq: number, seqOf: (e: T) => number | undefined) {
  const i = list.findIndex(e => (seqOf(e) ?? -Infinity) > seq);
  return i < 0 ? list.length : i;
}

// --- cards ---

export type CardRow = { kind: "card"; card: KnownCard } | { kind: "adding"; seq: number; title: string };
const rowSeq = (r: CardRow) => (r.kind === "adding" ? r.seq : r.card.addSeq);

/**
 * The loaded columns with the moves, adds and archives in the air replayed over them in the order they started, so
 * each lands where it was made: a move at the position it was shown at, an add at the bottom of To do.
 */
export function layColumns(base: Columns, writes: Write[]): Record<Column, CardRow[] | null> {
  const cols = {} as Record<Column, CardRow[] | null>;
  for (const c of COLUMNS) cols[c] = base[c]?.map(card => ({ kind: "card", card })) ?? null;
  const find = (id: number) => {
    for (const c of COLUMNS) {
      const list = cols[c];
      const i = list?.findIndex(r => r.kind === "card" && r.card.id === id) ?? -1;
      if (list && i >= 0) return { list, i };
    }
    return null;
  };
  for (const w of writes) {
    if (w.kind === "addCard") {
      const todo = cols.todo;
      if (todo) todo.splice(addSlot(todo, w.seq, rowSeq), 0, { kind: "adding", seq: w.seq, title: w.title });
      continue;
    }
    if (w.kind !== "move" && w.kind !== "archive") continue;
    const at = find(w.id);
    if (!at) continue;
    if (w.kind === "archive") {
      at.list.splice(at.i, 1);
      continue;
    }
    const target = cols[w.column];
    if (!target) continue;
    const [row] = at.list.splice(at.i, 1);
    target.splice(Math.min(w.index, target.length), 0, row);
  }
  return cols;
}

/** the card the server answered at `column`/`index`, taken out of wherever the page holds it */
export function placeCard(cols: Columns, id: number, column: Column, index: number): Columns {
  const card = COLUMNS.flatMap(c => cols[c] ?? []).find(x => x.id === id);
  const next = {} as Columns;
  for (const c of COLUMNS) next[c] = cols[c]?.filter(x => x.id !== id) ?? null;
  const target = next[column];
  if (card && target) target.splice(Math.min(index, target.length), 0, card);
  return next;
}

export const mapCards = (cols: Columns, f: (cards: KnownCard[]) => KnownCard[]): Columns => ({
  todo: cols.todo && f(cols.todo),
  doing: cols.doing && f(cols.doing),
  done: cols.done && f(cols.done),
});

// --- checklist items ---

export type ItemRow = { kind: "item"; id: number; text: string; done: boolean } | { kind: "adding"; seq: number; text: string };

/** a card's checklist with its toggles (the newest one per item) and item adds in the air laid over it */
export function layItems(base: KnownItem[], writes: Write[], cardId: number): ItemRow[] {
  const toggles = writesOf(writes, "toggle").filter(t => t.cardId === cardId);
  type Entry = { row: ItemRow; seq: number | undefined };
  const list: Entry[] = base.map(item => ({
    row: { kind: "item", id: item.id, text: item.text, done: newest(toggles, t => t.itemId === item.id)?.done ?? item.done },
    seq: item.addSeq,
  }));
  for (const a of writesOf(writes, "addItem"))
    if (a.cardId === cardId) list.splice(addSlot(list, a.seq, e => e.seq), 0, { row: { kind: "adding", seq: a.seq, text: a.text }, seq: a.seq });
  return list.map(e => e.row);
}

/** an item list's done and total, the adds in the air counted as not done */
export const countItems = (rows: ItemRow[]) => ({ done: rows.filter(r => r.kind === "item" && r.done).length, total: rows.length });
