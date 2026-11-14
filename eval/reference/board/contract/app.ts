// The board's data module: each source calls the backend in src/api.js and projects its answer onto the declared
// shape. The overlay shows the writes still out over the answers they change; the write errors are kept here, by
// kind, for `writeErrors` to report.
import type { Answer, Args, Overlay, Result, Sources, Write } from './app.contract.d.ts';
import * as api from './src/api.js';
import type { Column } from './src/api.js';

export const grants = '';

type Card = Result<'fetchCards'>[number];
type Item = Result<'fetchChecklist'>[number];
type Archived = Result<'fetchArchived'>;
type Kind = keyof Result<'writeErrors'>;

const card = (c: { id: number; title: string; done: number; total: number }): Card => ({
  id: c.id, title: c.title, done: c.done, total: c.total, adding: false, key: `card-${c.id}`,
});
const item = (i: { id: number; text: string; done: boolean }): Item => ({
  id: i.id, text: i.text, done: i.done, adding: false, key: `item-${i.id}`,
});

// The last failure of each kind of write, with the page visit and selection it was sent in and the latest send of its
// kind out at the time. It shows while its visit is open, no later send of its kind has started, and, for the
// detail's kinds, its card is still the one selected.
type Failed = { message: string; visit: number; pick: number; send: number };
const failures: Partial<Record<Kind, Failed>> = {};
const latest: Record<Kind, number> = { move: 0, add: 0, archive: 0, rename: 0, item: 0, restore: 0 };

async function write<T>(kind: Kind, visit: number, pick: number, send: number, call: Promise<T>): Promise<T> {
  latest[kind] = Math.max(latest[kind], send);
  try {
    return await call;
  } catch (e) {
    failures[kind] = { message: e instanceof Error ? e.message : String(e), visit, pick, send: latest[kind] };
    throw e;
  }
}

const sources: Sources = {
  fetchCards: async ([column]) => (await api.fetchCards(column as Column)).map(card),
  fetchChecklist: async ([id]) => (await api.fetchChecklist(id)).map(item),
  fetchArchived: async () => (await api.fetchArchived()).map((a) => ({ id: a.id, title: a.title })),
  writeErrors: ([visit, pick, moves, adds, archives, renames, items, restores]) => {
    const shown = (kind: Kind, send: number, scoped: boolean) => {
      const f = failures[kind];
      return f && f.visit === visit && f.send === send && (!scoped || f.pick === pick) ? f.message : '';
    };
    return {
      move: shown('move', moves, false),
      add: shown('add', adds, false),
      archive: shown('archive', archives, false),
      rename: shown('rename', renames, true),
      item: shown('item', items, true),
      restore: shown('restore', restores, false),
    };
  },

  moveCard: async ([id, column, index, , , , visit, send]) => {
    const r = await write('move', visit, 0, send, api.moveCard(id, column as Column, index));
    return { id: r.id, column: r.column, index: r.index };
  },
  addCard: async ([column, title, visit, send]) => {
    const r = await write('add', visit, 0, send, api.addCard(column as Column, title));
    return { id: r.id, title: r.title };
  },
  archiveCard: async ([id, visit, send]) => ({ id: (await write('archive', visit, 0, send, api.archiveCard(id))).id }),
  renameCard: async ([id, title, visit, pick, send]) => {
    const r = await write('rename', visit, pick, send, api.renameCard(id, title));
    return { id: r.id, title: r.title };
  },
  toggleItem: async ([cardId, itemId, done, visit, pick, send]) => {
    const r = await write('item', visit, pick, send, api.toggleItem(cardId, itemId, done));
    return { id: r.id, done: r.done };
  },
  addItem: async ([cardId, text, visit, pick, send]) => item(await write('item', visit, pick, send, api.addItem(cardId, text))),
  restoreCard: async ([id, visit, send]) => ({ id: (await write('restore', visit, 0, send, api.restoreCard(id))).id }),
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);

/** the page visit a write was sent in */
function visitOf(w: Write): number {
  switch (w.source) {
    case 'moveCard': return w.args[6];
    case 'addCard': return w.args[2];
    case 'archiveCard': return w.args[1];
    case 'renameCard': return w.args[2];
    case 'toggleItem': return w.args[3];
    case 'addItem': return w.args[2];
    case 'restoreCard': return w.args[1];
    default: return -1;
  }
}

/**
 * Puts an entry from the add with send `id` into a list: before the first entry a later add put there (that add was
 * answered first), else at the end, so added entries keep the order their adds started in.
 */
function insertAdded<T>(list: T[], entry: T, id: number, addedBy: Map<T, number>) {
  const at = list.findIndex((e) => (addedBy.get(e) ?? -1) > id);
  list.splice(at < 0 ? list.length : at, 0, entry);
  addedBy.set(entry, id);
}

function cardsShown(column: string, answer: Card[], writes: readonly Write[]): Card[] {
  let rows = [...answer];
  const addedBy = new Map<Card, number>();
  const patch = (id: number, f: (c: Card) => Card) => { rows = rows.map((c) => (c.id === id && !c.adding ? f(c) : c)); };
  for (const w of writes) {
    switch (w.source) {
      case 'moveCard': {
        const [id, to, index, title, done, total] = w.args;
        const [toColumn, toIndex] = w.reply ? [w.reply.column, w.reply.index] : [to, index];
        const at = rows.findIndex((c) => c.id === id && !c.adding);
        const moving = at >= 0 ? rows.splice(at, 1)[0] : card({ id, title, done, total });
        if (toColumn === column) rows.splice(Math.min(toIndex, rows.length), 0, moving);
        break;
      }
      case 'addCard': {
        if (column !== w.args[0]) break;
        if (w.reply) {
          const { id, title } = w.reply;
          if (!rows.some((c) => c.id === id && !c.adding)) insertAdded(rows, card({ id, title, done: 0, total: 0 }), w.id, addedBy);
        } else {
          insertAdded(rows, { id: 0, title: w.args[1], done: 0, total: 0, adding: true, key: `adding-${w.id}` }, w.id, addedBy);
        }
        break;
      }
      case 'archiveCard':
        rows = rows.filter((c) => c.adding || c.id !== w.args[0]);
        break;
      case 'renameCard': {
        const title = w.reply ? w.reply.title : w.args[1];
        patch(w.args[0], (c) => ({ ...c, title }));
        break;
      }
      case 'toggleItem': {
        const step = w.args[2] ? 1 : -1;
        patch(w.args[0], (c) => ({ ...c, done: Math.max(0, Math.min(c.total, c.done + step)) }));
        break;
      }
      case 'addItem':
        patch(w.args[0], (c) => ({ ...c, total: c.total + 1 }));
        break;
    }
  }
  return rows;
}

function itemsShown(cardId: number, answer: Item[], writes: readonly Write[]): Item[] {
  let rows = [...answer];
  const addedBy = new Map<Item, number>();
  for (const w of writes) {
    if (w.source === 'toggleItem' && w.args[0] === cardId) {
      const [, itemId, wanted] = w.args;
      const done = w.reply ? w.reply.done : wanted;
      rows = rows.map((i) => (i.id === itemId && !i.adding ? { ...i, done } : i));
    }
    if (w.source === 'addItem' && w.args[0] === cardId) {
      if (w.reply) {
        const added = w.reply;
        if (!rows.some((i) => i.id === added.id && !i.adding)) insertAdded(rows, item(added), w.id, addedBy);
      } else {
        insertAdded(rows, { id: 0, text: w.args[1], done: false, adding: true, key: `adding-${w.id}` }, w.id, addedBy);
      }
    }
  }
  return rows;
}

// The writes still out over the answers they change. A write whose reply landed before the answer was asked is in the
// answer already (`answered`), and one sent in another visit of the page belongs to a page that was left, so only the
// others are laid over it, in the order the runner gives them: the landed ones as they landed, then the rest as sent.
export const overlay: Overlay = (source, args, answer, writes) => {
  const visit = args[args.length - 1] as number;
  const out = writes.filter((w) => !w.answered && visitOf(w) === visit);
  switch (source) {
    case 'fetchCards':
      return cardsShown((args as Args<'fetchCards'>)[0], answer as Card[], out) as never;
    case 'fetchChecklist':
      return itemsShown((args as Args<'fetchChecklist'>)[0], answer as Item[], out) as never;
    case 'fetchArchived': {
      const gone = out.flatMap((w) => (w.source === 'restoreCard' ? [w.args[0]] : []));
      return (answer as Archived).filter((a) => !gone.includes(a.id)) as never;
    }
  }
  return undefined;
};
