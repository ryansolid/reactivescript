import { assign, enqueueActions, fromPromise, setup, stopChild } from "xstate";
import { loadSettings, saveSettings, type Settings } from "../api";
import { errorMessage, mutation, type MutationEvent } from "../mutation";

/** A save in flight: `seq` orders saves by when they started. */
type Save = { seq: number; settings: Settings };

type SettingsContext = {
  loadError: string;
  /** the settings as the server last saved them; null until they load */
  saved: Settings | null;
  /** the form: filled once from the loaded settings, then the user's */
  draft: Settings;
  seq: number;
  /** the saves in flight, oldest first */
  saves: Save[];
  /** the seq of the newest save the server accepted: an older save's answer must not replace it */
  confirmed: number;
  saveError: string;
};

type SettingsEvent =
  | { type: "load.retry" }
  | { type: "name.change"; value: string }
  | { type: "theme.set"; theme: Settings["theme"] }
  | { type: "density.toggle" }
  | { type: "save" }
  | MutationEvent<Save, Settings>;

export const NAME_MAX = 20;

/** why the display name cannot be saved, or "" when it can */
export function nameError(name: string) {
  if (name.length === 0) return "Display name is required";
  if (name.length > NAME_MAX) return `Display name must be at most ${NAME_MAX} characters, not ${name.length}`;
  return "";
}

/** the saved line: the newest save in flight not yet overtaken by an accepted one, else what was saved */
export function savedLine(ctx: SettingsContext): { settings: Settings | null; saving: boolean } {
  const pending = ctx.saves.filter(s => s.seq > ctx.confirmed).at(-1);
  return pending ? { settings: pending.settings, saving: true } : { settings: ctx.saved, saving: false };
}

const saveId = (seq: number) => `save-${seq}`;

export const settingsMachine = setup({
  types: { context: {} as SettingsContext, events: {} as SettingsEvent },
  actors: {
    loadSettings: fromPromise(() => loadSettings()),
    saveSettings: mutation((save: Save) => saveSettings(save.settings)),
  },
  guards: {
    draftValid: ({ context }) => nameError(context.draft.name) === "",
  },
}).createMachine({
  id: "settings",
  context: {
    loadError: "",
    saved: null,
    draft: { name: "", theme: "light", density: "comfortable" },
    seq: 0,
    saves: [],
    confirmed: 0,
    saveError: "",
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "loadSettings",
        onDone: { target: "ready", actions: assign(({ event }) => ({ saved: event.output, draft: event.output })) },
        onError: { target: "failed", actions: assign({ loadError: ({ event }) => errorMessage(event.error) }) },
      },
    },
    failed: { on: { "load.retry": "loading" } },
    ready: {
      on: {
        "name.change": { actions: assign({ draft: ({ context, event }) => ({ ...context.draft, name: event.value }) }) },
        "theme.set": { actions: assign({ draft: ({ context, event }) => ({ ...context.draft, theme: event.theme }) }) },
        "density.toggle": {
          actions: assign({
            draft: ({ context }) => ({
              ...context.draft,
              density: context.draft.density === "compact" ? "comfortable" : "compact",
            }),
          }),
        },
        save: {
          guard: "draftValid",
          actions: enqueueActions(({ context, enqueue }) => {
            const save: Save = { seq: context.seq + 1, settings: context.draft };
            enqueue.assign({ seq: save.seq, saves: [...context.saves, save], saveError: "" });
            enqueue.spawnChild("saveSettings", { id: saveId(save.seq), input: save });
          }),
        },
        "mutation.succeeded": {
          actions: [
            assign(({ context, event }) => ({
              saves: context.saves.filter(s => s.seq !== event.input.seq),
              ...(event.input.seq > context.confirmed ? { saved: event.output, confirmed: event.input.seq } : {}),
            })),
            stopChild(({ event }) => saveId(event.input.seq)),
          ],
        },
        "mutation.failed": {
          actions: [
            assign(({ context, event }) => ({
              saves: context.saves.filter(s => s.seq !== event.input.seq),
              // a save overtaken by a newer accepted one has nothing left to report
              ...(event.input.seq > context.confirmed ? { saveError: event.message } : {}),
            })),
            stopChild(({ event }) => saveId(event.input.seq)),
          ],
        },
      },
    },
  },
});
