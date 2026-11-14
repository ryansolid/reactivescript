import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { loadSettings, saveSettings, type Density, type Settings, type Theme } from "./api";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const [saveError, setSaveError] = useState("");
  // saves still in the air, oldest first; the newest one shows until it answers or a newer one is confirmed
  const [saving, setSaving] = useState<{ seq: number; value: Settings }[]>([]);
  const seqRef = useRef(0);
  const confirmedRef = useRef(0);

  const save = async (next: Settings) => {
    const seq = ++seqRef.current;
    setSaveError("");
    setSaving(prev => [...prev, { seq, value: next }]);
    try {
      const saved = await saveSettings(next);
      if (seq > confirmedRef.current) {
        confirmedRef.current = seq;
        queryClient.setQueryData(["settings"], saved);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(prev => prev.filter(p => p.seq !== seq));
    }
  };

  if (settings.isPending) return <p data-testid="load">Loading settings…</p>;
  if (settings.error) return (
    <section>
      <p data-testid="load">Could not load settings: {settings.error.message}</p>{" "}
      <button data-testid="retry-load" onClick={() => settings.refetch()}>Retry</button>
    </section>
  );
  const guess = saving.filter(p => p.seq > confirmedRef.current).at(-1);
  const s = guess?.value ?? settings.data;
  return (
    <main>
      <p data-testid="saved">Saved: {s.name} · {s.theme} · {s.density}{guess ? " (saving…)" : ""}</p>{" "}
      {saveError && <p data-testid="save-error">Save failed: {saveError}</p>}
      <SettingsForm initial={settings.data} onSave={draft => void save(draft)} />
    </main>
  );
}

function nameError(name: string) {
  if (name.length === 0) return "Display name is required";
  if (name.length > 20) return `Display name must be at most 20 characters, not ${name.length}`;
  return "";
}

// Seeded once from the loaded settings; after that the draft is the user's.
function SettingsForm({ initial, onSave }: { initial: Settings; onSave: (draft: Settings) => void }) {
  const [name, setName] = useState(initial.name);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [density, setDensity] = useState<Density>(initial.density);
  const error = nameError(name);
  return (
    <div>
      <label>Display name <input data-testid="name" value={name} onChange={e => setName(e.target.value)} /></label>{" "}
      <small data-testid="name-count">{name.length}/20</small>{" "}
      {error && <p data-testid="name-error">{error}</p>}
      <div>
        <span>Theme: {theme}</span>{" "}
        <button data-testid="theme-light" onClick={() => setTheme("light")}>light</button>{" "}
        <button data-testid="theme-dark" onClick={() => setTheme("dark")}>dark</button>{" "}
        <button data-testid="density-toggle" onClick={() => setDensity(d => (d === "compact" ? "comfortable" : "compact"))}>Toggle density</button>{" "}
        <p data-testid="preview">Preview: {theme} / {density}</p>
      </div>
      <button data-testid="save" onClick={() => { if (!error) onSave({ name, theme, density }); }}>Save</button>
    </div>
  );
}
