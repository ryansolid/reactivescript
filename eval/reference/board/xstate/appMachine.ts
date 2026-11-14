import { setup } from "xstate";
import { createActorContext } from "@xstate/react";
import { boardMachine } from "./board/boardMachine";
import { archiveMachine } from "./archive/archiveMachine";

/**
 * The app: one page at a time, each an actor invoked while its tab is open. Leaving a page stops its actor, and with it
 * every request the page still has in flight, so reopening a page starts it fresh.
 */
export const appMachine = setup({
  types: {
    events: {} as { type: "tab.board" } | { type: "tab.archive" },
    children: {} as { board: "boardPage"; archive: "archivePage" },
  },
  actors: { boardPage: boardMachine, archivePage: archiveMachine },
}).createMachine({
  id: "app",
  initial: "board",
  on: {
    "tab.board": ".board",
    "tab.archive": ".archive",
  },
  states: {
    board: { invoke: { id: "board", src: "boardPage" } },
    archive: { invoke: { id: "archive", src: "archivePage" } },
  },
});

export const AppActor = createActorContext(appMachine);
