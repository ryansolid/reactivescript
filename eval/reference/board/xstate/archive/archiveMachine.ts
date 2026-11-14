import { assign, enqueueActions, fromPromise, setup, stopChild } from "xstate";
import { fetchArchived, restoreCard, type Archived } from "../api";
import { errorMessage, mutation, type MutationEvent } from "../mutation";

/** A restore in flight: `seq` keeps two restores of one row apart. */
type Restore = { seq: number; id: number };

type ArchiveContext = {
  /** the archive as the server last answered it */
  rows: Archived[];
  loadError: string;
  seq: number;
  /** the restores in flight, oldest first */
  restoring: Restore[];
  restoreError: string | null;
};

type ArchiveEvent = { type: "restore"; id: number } | MutationEvent<Restore, { id: number }>;

/** the rows as shown: the ones being restored are off the list until the server declines */
export const shownRows = (ctx: ArchiveContext) => ctx.rows.filter(a => !ctx.restoring.some(r => r.id === a.id));

const restoreId = (seq: number) => `restore-${seq}`;

export const archiveMachine = setup({
  types: { context: {} as ArchiveContext, events: {} as ArchiveEvent },
  actors: {
    fetchArchived: fromPromise(() => fetchArchived()),
    restore: mutation((r: Restore) => restoreCard(r.id)),
  },
}).createMachine({
  id: "archive",
  context: { rows: [], loadError: "", seq: 0, restoring: [], restoreError: null },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "fetchArchived",
        onDone: { target: "loaded", actions: assign({ rows: ({ event }) => event.output }) },
        onError: { target: "failed", actions: assign({ loadError: ({ event }) => errorMessage(event.error) }) },
      },
    },
    failed: {},
    loaded: {
      on: {
        restore: {
          actions: enqueueActions(({ context, enqueue, event }) => {
            const restore: Restore = { seq: context.seq + 1, id: event.id };
            enqueue.assign({ seq: restore.seq, restoring: [...context.restoring, restore], restoreError: null });
            enqueue.spawnChild("restore", { id: restoreId(restore.seq), input: restore });
          }),
        },
        "mutation.succeeded": {
          actions: [
            assign(({ context, event }) => ({
              rows: context.rows.filter(a => a.id !== event.output.id),
              restoring: context.restoring.filter(r => r.seq !== event.input.seq),
            })),
            stopChild(({ event }) => restoreId(event.input.seq)),
          ],
        },
        "mutation.failed": {
          actions: [
            assign(({ context, event }) => ({
              restoreError: event.message,
              restoring: context.restoring.filter(r => r.seq !== event.input.seq),
            })),
            stopChild(({ event }) => restoreId(event.input.seq)),
          ],
        },
      },
    },
  },
});
