import { assign, enqueueActions, fromPromise, setup, stopChild } from "xstate";
import * as api from "../api";
import type { Column, Item } from "../api";
import { errorMessage, mutation, type MutationEvent } from "../mutation";
import {
  COLUMNS,
  WIP_LIMIT,
  addSlot,
  countItems,
  isColumn,
  layColumns,
  layItems,
  mapCards,
  newest,
  placeCard,
  writesOf,
  type Columns,
  type ItemRow,
  type KnownItem,
  type Write,
  type WriteRequest,
} from "./lay";

/** What the server answered a write, in the terms the page needs. */
type Outcome =
  | { kind: "moved"; id: number; column: string; index: number }
  | { kind: "cardAdded"; id: number; title: string }
  | { kind: "archived"; id: number }
  | { kind: "renamed"; id: number; title: string }
  | { kind: "toggled"; id: number; done: boolean }
  | { kind: "itemAdded"; item: Item };

async function perform(w: Write): Promise<Outcome> {
  switch (w.kind) {
    case "move":
      return { kind: "moved", ...(await api.moveCard(w.id, w.column, w.index)) };
    case "addCard":
      return { kind: "cardAdded", ...(await api.addCard("todo", w.title)) };
    case "archive":
      return { kind: "archived", ...(await api.archiveCard(w.id)) };
    case "rename":
      return { kind: "renamed", ...(await api.renameCard(w.id, w.title)) };
    case "toggle":
      return { kind: "toggled", ...(await api.toggleItem(w.cardId, w.itemId, w.done)) };
    case "addItem":
      return { kind: "itemAdded", item: await api.addItem(w.cardId, w.text) };
  }
}

/** Each kind of failure has one line on screen. */
export type Channel = "move" | "add" | "archive" | "rename" | "item";
const CHANNEL: Record<Write["kind"], Channel> = {
  move: "move",
  addCard: "add",
  archive: "archive",
  rename: "rename",
  toggle: "item",
  addItem: "item",
};
/** the detail's lines belong to the selection they happened in; the board's stay until their next write starts */
const DETAIL_CHANNELS: Channel[] = ["rename", "item"];

export type BoardContext = {
  /** each column's cards as the server last answered them; null until the column loads */
  cards: Columns;
  cardsError: Record<Column, string>;
  /** the checklists this page has loaded, by card, as the server last answered them; kept for the page's life */
  checklists: Record<number, KnownItem[]>;
  checklistError: string;
  selected: number | null;
  /** counts selections, even of the same card again */
  visit: number;
  newCard: string;
  titleInput: string;
  itemInput: string;
  seq: number;
  /** the writes in flight, oldest first */
  writes: Write[];
  errors: Partial<Record<Channel, { visit: number; message: string }>>;
};

export type BoardEvent =
  | { type: "column.retry"; column: Column }
  | { type: "newCard.change"; value: string }
  | { type: "title.change"; value: string }
  | { type: "item.change"; value: string }
  | { type: "card.add" }
  | { type: "card.move"; id: number; column: Column; index: number }
  | { type: "card.select"; id: number }
  | { type: "card.rename" }
  | { type: "card.archive" }
  | { type: "item.toggle"; itemId: number; done: boolean }
  | { type: "item.add" }
  | MutationEvent<Write, Outcome>;

// --- what the page shows ---

/** a card as the board shows it, or one being added (no id yet) */
export type ShownRow = { kind: "card"; id: number; title: string; done: number; total: number } | { kind: "adding"; seq: number; title: string };
export type ShownBoard = Record<Column, ShownRow[] | null>;

/** a card's checklist as shown, or null while it has not loaded */
export function shownItems(ctx: BoardContext, cardId: number): ItemRow[] | null {
  const items = ctx.checklists[cardId];
  return items ? layItems(items, ctx.writes, cardId) : null;
}

/** the columns as shown; a card whose checklist is known counts its items as the checklist shows them */
export function shownBoard(ctx: BoardContext): ShownBoard {
  const laid = layColumns(ctx.cards, ctx.writes);
  const renames = writesOf(ctx.writes, "rename");
  const board = {} as ShownBoard;
  for (const c of COLUMNS)
    board[c] =
      laid[c]?.map(r => {
        if (r.kind === "adding") return r;
        const items = shownItems(ctx, r.card.id);
        const { done, total } = items ? countItems(items) : r.card;
        const title = newest(renames, n => n.id === r.card.id)?.title ?? r.card.title;
        return { kind: "card", id: r.card.id, title, done, total };
      }) ?? null;
  return board;
}

/** the selected card as the board shows it, and where; null while nothing selected shows */
export function selectedCard(ctx: BoardContext, board: ShownBoard) {
  for (const column of COLUMNS)
    for (const r of board[column] ?? []) if (r.kind === "card" && r.id === ctx.selected) return { id: r.id, title: r.title, column };
  return null;
}

/** whether a card from another column may move into `target`: it has loaded, and Doing is under its limit */
export function canEnter(board: ShownBoard, target: Column) {
  const rows = board[target];
  return rows !== null && (target !== "doing" || rows.length < WIP_LIMIT);
}

/** the error line of `channel`, if it belongs on screen now */
export function errorOf(ctx: BoardContext, channel: Channel) {
  const e = ctx.errors[channel];
  return e && (!DETAIL_CHANNELS.includes(channel) || e.visit === ctx.visit) ? e.message : null;
}

// --- applying the server's answers ---

function accepted(ctx: BoardContext, w: Write, out: Outcome): Partial<BoardContext> {
  switch (out.kind) {
    case "moved": {
      const column = isColumn(out.column) ? out.column : w.kind === "move" ? w.column : "todo";
      return { cards: placeCard(ctx.cards, out.id, column, out.index) };
    }
    case "cardAdded": {
      const todo = ctx.cards.todo;
      // a reload of To do may already hold it
      if (!todo || todo.some(x => x.id === out.id)) return {};
      const next = [...todo];
      next.splice(addSlot(todo, w.seq, x => x.addSeq), 0, { id: out.id, title: out.title, done: 0, total: 0, addSeq: w.seq });
      return { cards: { ...ctx.cards, todo: next } };
    }
    case "archived":
      return { cards: mapCards(ctx.cards, cards => cards.filter(x => x.id !== out.id)) };
    case "renamed":
      return { cards: mapCards(ctx.cards, cards => cards.map(x => (x.id === out.id ? { ...x, title: out.title } : x))) };
    case "toggled": {
      if (w.kind !== "toggle") return {};
      const items = ctx.checklists[w.cardId];
      if (!items) return {};
      return { checklists: { ...ctx.checklists, [w.cardId]: items.map(i => (i.id === out.id ? { ...i, done: out.done } : i)) } };
    }
    case "itemAdded": {
      if (w.kind !== "addItem") return {};
      const items = ctx.checklists[w.cardId];
      if (!items || items.some(i => i.id === out.item.id)) return {};
      const next = [...items];
      next.splice(addSlot(items, w.seq, i => i.addSeq), 0, { ...out.item, addSeq: w.seq });
      return { checklists: { ...ctx.checklists, [w.cardId]: next } };
    }
  }
}

const writeId = (seq: number) => `write-${seq}`;
const withoutWrite = (ctx: BoardContext, w: Write) => ctx.writes.filter(x => x.seq !== w.seq);

const board = setup({
  types: { context: {} as BoardContext, events: {} as BoardEvent },
  actors: {
    fetchCards: fromPromise(async ({ input }: { input: Column }) => ({ column: input, cards: await api.fetchCards(input) })),
    fetchChecklist: fromPromise(async ({ input }: { input: number }) => ({ cardId: input, items: await api.fetchChecklist(input) })),
    write: mutation(perform),
  },
  actions: {
    /** start a write: it shows at once, clears its channel's error, and goes to the server */
    startWrite: enqueueActions(({ context, enqueue }, request: WriteRequest) => {
      const write: Write = { ...request, seq: context.seq + 1, visit: context.visit };
      enqueue.assign({
        seq: write.seq,
        writes: [...context.writes, write],
        errors: { ...context.errors, [CHANNEL[write.kind]]: undefined },
      });
      enqueue.spawnChild("write", { id: writeId(write.seq), input: write });
    }),
  },
  guards: {
    newCardTyped: ({ context }) => context.newCard !== "" && context.cards.todo !== null,
    moveAllowed: ({ context, event }) => {
      if (event.type !== "card.move") return false;
      const shown = shownBoard(context);
      const from = COLUMNS.find(c => shown[c]?.some(r => r.kind === "card" && r.id === event.id));
      return from !== undefined && (from === event.column || canEnter(shown, event.column));
    },
    selectedShown: ({ context }) => selectedCard(context, shownBoard(context)) !== null,
    titleTyped: ({ context }) => context.titleInput !== "" && selectedCard(context, shownBoard(context)) !== null,
    itemTyped: ({ context }) =>
      context.itemInput !== "" && context.selected !== null && context.checklists[context.selected] !== undefined && selectedCard(context, shownBoard(context)) !== null,
    checklistKnown: ({ context }) => context.selected !== null && context.checklists[context.selected] !== undefined,
  },
});

/** one column: it loads when the page opens, and a failed load can be asked again */
const column = (c: Column) =>
  board.createStateConfig({
    initial: "loading",
    states: {
      loading: {
        invoke: {
          src: "fetchCards",
          input: c,
          onDone: {
            target: "loaded",
            actions: assign({ cards: ({ context, event }) => ({ ...context.cards, [event.output.column]: event.output.cards }) }),
          },
          onError: {
            target: "failed",
            actions: assign({ cardsError: ({ context, event }) => ({ ...context.cardsError, [c]: errorMessage(event.error) }) }),
          },
        },
      },
      loaded: {},
      failed: {
        on: { "column.retry": { guard: ({ event }) => event.column === c, target: "loading" } },
      },
    },
  });

export const boardMachine = board.createMachine({
  id: "board",
  type: "parallel",
  context: {
    cards: { todo: null, doing: null, done: null },
    cardsError: { todo: "", doing: "", done: "" },
    checklists: {},
    checklistError: "",
    selected: null,
    visit: 0,
    newCard: "",
    titleInput: "",
    itemInput: "",
    seq: 0,
    writes: [],
    errors: {},
  },
  on: {
    "newCard.change": { actions: assign({ newCard: ({ event }) => event.value }) },
    "title.change": { actions: assign({ titleInput: ({ event }) => event.value }) },
    "item.change": { actions: assign({ itemInput: ({ event }) => event.value }) },
    "card.add": {
      guard: "newCardTyped",
      actions: [{ type: "startWrite", params: ({ context }) => ({ kind: "addCard", title: context.newCard }) }, assign({ newCard: "" })],
    },
    "card.move": {
      guard: "moveAllowed",
      actions: { type: "startWrite", params: ({ event }) => ({ kind: "move", id: event.id, column: event.column, index: event.index }) },
    },
    "mutation.succeeded": {
      actions: [
        assign(({ context, event }) => ({ ...accepted(context, event.input, event.output), writes: withoutWrite(context, event.input) })),
        stopChild(({ event }) => writeId(event.input.seq)),
      ],
    },
    "mutation.failed": {
      actions: [
        assign(({ context, event }) => ({
          errors: { ...context.errors, [CHANNEL[event.input.kind]]: { visit: event.input.visit, message: event.message } },
          writes: withoutWrite(context, event.input),
        })),
        stopChild(({ event }) => writeId(event.input.seq)),
      ],
    },
  },
  states: {
    todo: column("todo"),
    doing: column("doing"),
    done: column("done"),
    detail: {
      initial: "none",
      on: {
        "card.select": {
          target: ".checking",
          actions: assign(({ context, event }) => ({ selected: event.id, visit: context.visit + 1, titleInput: "", itemInput: "" })),
        },
        "card.rename": {
          guard: "titleTyped",
          actions: { type: "startWrite", params: ({ context }) => ({ kind: "rename", id: context.selected!, title: context.titleInput }) },
        },
        "card.archive": {
          guard: "selectedShown",
          target: ".none",
          actions: [{ type: "startWrite", params: ({ context }) => ({ kind: "archive", id: context.selected! }) }, assign({ selected: null })],
        },
        "item.toggle": {
          guard: "selectedShown",
          actions: {
            type: "startWrite",
            params: ({ context, event }) => ({ kind: "toggle", cardId: context.selected!, itemId: event.itemId, done: event.done }),
          },
        },
        "item.add": {
          guard: "itemTyped",
          actions: [
            { type: "startWrite", params: ({ context }) => ({ kind: "addItem", cardId: context.selected!, text: context.itemInput }) },
            assign({ itemInput: "" }),
          ],
        },
      },
      states: {
        none: {},
        // a checklist this page already has shows as it is; any other loads
        checking: { always: [{ guard: "checklistKnown", target: "loaded" }, { target: "loading" }] },
        loading: {
          invoke: {
            src: "fetchChecklist",
            input: ({ context }) => context.selected!,
            onDone: {
              target: "loaded",
              actions: assign({ checklists: ({ context, event }) => ({ ...context.checklists, [event.output.cardId]: event.output.items }) }),
            },
            onError: { target: "failed", actions: assign({ checklistError: ({ event }) => errorMessage(event.error) }) },
          },
        },
        loaded: {},
        failed: {},
      },
    },
  },
});
