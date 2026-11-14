import { assign, fromPromise, setup } from "xstate";
import { fetchItem, search, type Hit, type Item } from "../api";
import { errorMessage } from "../mutation";

/** Where the help page opens: empty from its tab, on an issue's title with a hit chosen from a related hit. */
export type HelpInput = { query: string; selected: number | null };

type HelpContext = {
  query: string;
  /** the results on screen and the query they answer */
  results: { query: string; hits: Hit[] } | null;
  searchError: string;
  selected: number | null;
  item: Item | null;
  itemError: string;
};

type HelpEvent = { type: "query.change"; value: string } | { type: "hit.select"; id: number } | { type: "item.retry" };

export const helpMachine = setup({
  types: { context: {} as HelpContext, events: {} as HelpEvent, input: {} as HelpInput },
  actors: {
    search: fromPromise(({ input }: { input: string }) => search(input)),
    fetchItem: fromPromise(({ input }: { input: number }) => fetchItem(input)),
  },
  guards: {
    emptyQuery: ({ context }) => context.query === "",
    shortQuery: ({ context }) => context.query.length < 2,
    hitSelected: ({ context }) => context.selected !== null,
  },
  actions: {
    clearResults: assign({ results: null }),
  },
}).createMachine({
  id: "help",
  type: "parallel",
  context: ({ input }) => ({ ...input, results: null, searchError: "", item: null, itemError: "" }),
  states: {
    search: {
      initial: "checking",
      on: {
        // every keystroke starts over: a search still in flight for an older query is dropped
        "query.change": { target: ".checking", actions: assign({ query: ({ event }) => event.value }) },
      },
      states: {
        checking: {
          always: [
            { guard: "emptyQuery", target: "empty" },
            { guard: "shortQuery", target: "tooShort" },
            { target: "searching" },
          ],
        },
        empty: { entry: "clearResults" },
        tooShort: { entry: "clearResults" },
        // the results on screen stay up until these replace them
        searching: {
          invoke: {
            src: "search",
            input: ({ context }) => context.query,
            onDone: {
              target: "found",
              actions: assign({ results: ({ context, event }) => ({ query: context.query, hits: event.output }) }),
            },
            onError: {
              target: "failed",
              actions: [assign({ searchError: ({ event }) => errorMessage(event.error) }), "clearResults"],
            },
          },
        },
        found: {},
        failed: {},
      },
    },
    item: {
      initial: "checking",
      on: {
        "hit.select": { target: ".loading", actions: assign({ selected: ({ event }) => event.id }) },
      },
      states: {
        checking: { always: [{ guard: "hitSelected", target: "loading" }, { target: "none" }] },
        none: {},
        loading: {
          invoke: {
            src: "fetchItem",
            input: ({ context }) => context.selected!,
            onDone: [
              { guard: ({ event }) => event.output === null, target: "notFound" },
              { target: "loaded", actions: assign({ item: ({ event }) => event.output }) },
            ],
            onError: { target: "failed", actions: assign({ itemError: ({ event }) => errorMessage(event.error) }) },
          },
        },
        loaded: {},
        notFound: {},
        failed: { on: { "item.retry": "loading" } },
      },
    },
  },
});
