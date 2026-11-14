import { assign, setup } from "xstate";
import { createActorContext } from "@xstate/react";
import { issuesMachine, openCount } from "./issues/issuesMachine";
import { helpMachine, type HelpInput } from "./help/helpMachine";
import { settingsMachine } from "./settings/settingsMachine";

type AppEvent =
  | { type: "tab.issues" }
  | { type: "tab.help" }
  | { type: "tab.settings" }
  /** open the help page on a query with a hit chosen (a related hit on the issues page) */
  | ({ type: "help.open" } & HelpInput);

/**
 * The desk: one page at a time, each an actor invoked while its tab is open. Leaving a page stops its actor, and with
 * it every request the page still has in flight, so reopening a page starts it fresh.
 */
export const appMachine = setup({
  types: {
    context: {} as {
      /** the number of open issues the issues page last showed; null until they have loaded once */
      openCount: number | null;
      help: HelpInput;
    },
    events: {} as AppEvent,
    children: {} as { issues: "issuesPage"; help: "helpPage"; settings: "settingsPage" },
  },
  actors: { issuesPage: issuesMachine, helpPage: helpMachine, settingsPage: settingsMachine },
}).createMachine({
  id: "desk",
  context: { openCount: null, help: { query: "", selected: null } },
  initial: "issues",
  on: {
    "tab.issues": ".issues",
    "tab.help": { target: ".help", actions: assign({ help: { query: "", selected: null } }) },
    "tab.settings": ".settings",
    "help.open": { target: ".help", actions: assign({ help: ({ event }) => ({ query: event.query, selected: event.selected }) }) },
  },
  states: {
    issues: {
      invoke: {
        id: "issues",
        src: "issuesPage",
        // the tab's count follows the open list while the page shows it, and keeps its number otherwise
        onSnapshot: { actions: assign({ openCount: ({ context, event }) => openCount(event.snapshot) ?? context.openCount }) },
      },
    },
    help: { invoke: { id: "help", src: "helpPage", input: ({ context }) => context.help } },
    settings: { invoke: { id: "settings", src: "settingsPage" } },
  },
});

export const AppActor = createActorContext(appMachine);
