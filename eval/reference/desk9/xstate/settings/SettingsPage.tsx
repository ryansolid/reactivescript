import { useSelector } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { NAME_MAX, nameError, savedLine, type settingsMachine } from "./settingsMachine";

export default function SettingsPage({ actor }: { actor: ActorRefFrom<typeof settingsMachine> }) {
  const state = useSelector(actor, s => s);
  const { context } = state;
  const { send } = actor;
  if (state.matches("loading")) return <p data-testid="load">Loading settings…</p>;
  if (state.matches("failed"))
    return (
      <section>
        <p data-testid="load">Could not load settings: {context.loadError}</p>{" "}
        <button type="button" data-testid="retry-load" onClick={() => send({ type: "load.retry" })}>
          Retry
        </button>
      </section>
    );
  const { settings: saved, saving } = savedLine(context);
  const { draft } = context;
  const error = nameError(draft.name);
  return (
    <main>
      {saved && (
        <p data-testid="saved">
          Saved: {saved.name} · {saved.theme} · {saved.density}
          {saving ? " (saving…)" : ""}
        </p>
      )}
      {context.saveError && <p data-testid="save-error">Save failed: {context.saveError}</p>}
      <div>
        <label>
          Display name <input data-testid="name" value={draft.name} onChange={e => send({ type: "name.change", value: e.target.value })} />
        </label>{" "}
        <small data-testid="name-count">
          {draft.name.length}/{NAME_MAX}
        </small>
        {error && <p data-testid="name-error">{error}</p>}
      </div>
      <div>
        <span>Theme: {draft.theme}</span>{" "}
        <button type="button" data-testid="theme-light" onClick={() => send({ type: "theme.set", theme: "light" })}>
          light
        </button>{" "}
        <button type="button" data-testid="theme-dark" onClick={() => send({ type: "theme.set", theme: "dark" })}>
          dark
        </button>{" "}
        <button type="button" data-testid="density-toggle" onClick={() => send({ type: "density.toggle" })}>
          Toggle density
        </button>
        <p data-testid="preview">
          Preview: {draft.theme} / {draft.density}
        </p>
      </div>
      <button type="button" data-testid="save" onClick={() => send({ type: "save" })}>
        Save
      </button>
    </main>
  );
}
