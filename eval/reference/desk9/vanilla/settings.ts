// The settings page: loads the settings, then a draft that belongs to the user and saves it.
import * as api from "./api";
import type { Settings, Theme } from "./api";
import { button, errorMessage, h, textInput } from "./dom";
import { Clock, Register } from "./register";

const MAX_NAME = 20;

function nameError(name: string) {
  if (name.length === 0) return "Display name is required";
  if (name.length > MAX_NAME) return `Display name must be at most ${MAX_NAME} characters, not ${name.length}`;
  return null;
}

export function settingsPage(signal: AbortSignal): HTMLElement {
  const root = h("main", { className: "settings" });

  async function load() {
    root.replaceChildren(h("p", { testid: "load" }, "Loading settings…"));
    try {
      const settings = await api.loadSettings();
      if (signal.aborted) return;
      root.replaceChildren(editor(signal, settings));
    } catch (e) {
      if (signal.aborted) return;
      root.replaceChildren(
        h("p", { testid: "load" }, `Could not load settings: ${errorMessage(e)}`),
        " ",
        button("retry-load", "Retry", () => void load()),
      );
    }
  }

  void load();
  return root;
}

/** the saved line and the draft, seeded once from `loaded` */
function editor(signal: AbortSignal, loaded: Settings): HTMLElement {
  const saved = new Register<Settings>(new Clock());
  saved.learn(loaded, 0);
  let saveError: string | null = null;
  const draft: Settings = { ...loaded };

  const savedEl = h("p", { testid: "saved" });
  const saveErrorEl = h("div");
  const countEl = h("small", { testid: "name-count" });
  const nameErrorEl = h("div");
  const previewEl = h("p", { testid: "preview" });

  const setTheme = (theme: Theme) => {
    draft.theme = theme;
    render();
  };
  const toggleDensity = () => {
    draft.density = draft.density === "compact" ? "comfortable" : "compact";
    render();
  };

  async function save() {
    if (nameError(draft.name) !== null) return;
    const value = { ...draft };
    const write = saved.write(value);
    saveError = null;
    render();
    try {
      const answer = await api.saveSettings(value);
      if (signal.aborted) return;
      write.accepted(answer);
    } catch (e) {
      if (signal.aborted) return;
      write.declined();
      saveError = errorMessage(e);
    }
    render();
  }

  function render() {
    const s = saved.shown(loaded);
    savedEl.textContent = `Saved: ${s.name} · ${s.theme} · ${s.density}${saved.guessing() ? " (saving…)" : ""}`;
    saveErrorEl.replaceChildren(saveError === null ? "" : h("p", { testid: "save-error" }, `Save failed: ${saveError}`));
    countEl.textContent = `${draft.name.length}/${MAX_NAME}`;
    const error = nameError(draft.name);
    nameErrorEl.replaceChildren(error === null ? "" : h("p", { testid: "name-error" }, error));
    previewEl.textContent = `Preview: ${draft.theme} / ${draft.density}`;
  }

  const root = h(
    "div",
    null,
    savedEl,
    saveErrorEl,
    h(
      "div",
      null,
      h("label", null, "Display name ", textInput("name", draft.name, value => {
        draft.name = value;
        render();
      })),
      " ",
      countEl,
      nameErrorEl,
    ),
    h(
      "div",
      null,
      button("theme-light", "light", () => setTheme("light")),
      " ",
      button("theme-dark", "dark", () => setTheme("dark")),
      " ",
      button("density-toggle", "Toggle density", toggleDensity),
      previewEl,
    ),
    button("save", "Save", () => void save()),
  );
  render();
  return root;
}
