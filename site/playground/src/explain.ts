export type Note = { helper: string; name?: string; reads: string[]; text: string };

/** The `.rx` form each Solid primitive in the view stands for (spec/11 CP-4b, @reactivescript/runtime). */
export const SOLID_PRIMS: Record<string, string> = {
  createSignal: "source x := e (ST-1); for source x = await …, its truth (ST-5)",
  createStore: "source x := […] or {…}: structured, a store (ST-2a)",
  createOptimistic: "source x = … that an action guesses (AC-3)",
  createOptimisticStore: "a keyed or structured source an action guesses by row (AC-3)",
  createMemo: "an equation x = e (E-1), and each hoisted await (R-1)",
  createProjection: "x key k = e (ST-4), and x = draft(pre x -> seed) { … } (ST-3)",
  action: "action f(…) { … } (AC-1): each await is a yield",
  affects: "affects x (AC-5)",
  refresh: "refresh x (AC-4)",
  untrack: "a read in imperative scope: a snapshot (H-10)",
  latest: "latest x (R-12)",
  isPending: "pending? x (R-9)",
  onFlush: "onFlush(() => { … }) (EF-8)",
  onSettled: "onSettled (EF-7)",
  until: "until (AC-6)",
  Errored: "errored fallback(e) { … } { … } (R-f-4)",
  Loading: "loading fallback { … } { … }",
  Show: "if c { … } else { … }",
  For: "for x in xs { … }",
  Repeat: "for i in 0..n { … }",
};

export function primsIn(code: string): { name: string; from: string }[] {
  const m = /^import \{([^}]*)\} from "solid-js";/m.exec(code);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((n) => SOLID_PRIMS[n])
    .map((name) => ({ name, from: SOLID_PRIMS[name] }));
}

const reads = (s: string, skip: string) =>
  [...new Set([...s.matchAll(/\b([A-Za-z_]\w*(?:\$await\d*)?)\(\)/g)].map((r) => r[1].replace(/\$await\d*$/, " (the await)")))].filter((r) => r !== skip);

/** A note for a line of the view: the `.rx` form it was written as. */
export function noteFor(line: string): Note | undefined {
  let m: RegExpExecArray | null;
  if ((m = /const \[(\w+)\$truth, set\w+\] = createSignal\((.*)$/.exec(line)))
    return { helper: "createSignal", name: m[1], reads: reads(m[2], m[1]), text: `source ${m[1]} = …: its answer, the truth a guess reverts to` };
  if ((m = /const \[(\w+), guess\w+\] = createOptimistic\(/.exec(line)))
    return { helper: "createOptimistic", name: m[1], reads: [], text: `source ${m[1]} as shown: \`guess ${m[1]} := v\` writes over the truth (AC-3)` };
  if ((m = /const \[(\w+), set\w+\] = createSignal\((.*)$/.exec(line)))
    return { helper: "createSignal", name: m[1], reads: reads(m[2], m[1]), text: /^\(\) =>/.test(m[2]) ? `source ${m[1]} = …: a source with a question (ST-5)` : `source ${m[1]} := … (ST-1)` };
  if ((m = /const \[(\w+), set\w+\] = create(?:Optimistic)?Store\((.*)$/.exec(line)))
    return { helper: "createStore", name: m[1], reads: reads(m[2], m[1]), text: `source ${m[1]}, structured: a store (ST-2a)` };
  if ((m = /const (\w+)\$answer = createMemo\((.*)$/.exec(line)))
    return { helper: "createMemo", name: m[1], reads: reads(m[2], ""), text: `the answer of ${m[1]} key … = …, before rows are matched by key` };
  if ((m = /const (\w+) = createProjection\(\(\) => \w+\$answer\(\), \[\], \{ key: ("?\w+"?) \}/.exec(line)))
    return { helper: "createProjection", name: m[1], reads: [], text: `${m[1]} key ${m[2].replace(/"/g, "")} = …: each row keeps its identity by ${m[2].replace(/"/g, "")} (ST-4)` };
  if ((m = /const (\w+) = createProjection\(\((\w+)\) =>/.exec(line)))
    return { helper: "createProjection", name: m[1], reads: [], text: `${m[1]} = draft(pre ${m[1]} -> seed) { … }: writes to ${m[2]} change only those paths (ST-3)` };
  if ((m = /const (\w+)\$await\d* = createMemo\((.*)$/.exec(line)))
    return { helper: "createMemo", name: m[1], reads: reads(m[2], ""), text: `the await in ${m[1]}, hoisted to its own memo (R-1)` };
  if ((m = /const (\w+) = createMemo\((.*)$/.exec(line))) return { helper: "createMemo", name: m[1], reads: reads(m[2], m[1]), text: `equation ${m[1]} = … (E-1)` };
  if ((m = /const (\w+) = action\(/.exec(line))) return { helper: "action", name: m[1], reads: [], text: `action ${m[1]}(…): its body is one change; each await is a yield (AC-1)` };
  if ((m = /^\s*guess(\w)(\w*)\(/.exec(line))) {
    const n = m[1].toLowerCase() + m[2];
    return { helper: "guess", name: n, reads: [], text: `guess ${n} := …: shows now, reverts if the action fails` };
  }
  if ((m = /^\s*affects\((\w+)\)/.exec(line))) return { helper: "affects", name: m[1], reads: [], text: `affects ${m[1]}: pending? ${m[1]} is true while the action runs` };
  if (/^\s*onFlush\(/.test(line)) return { helper: "onFlush", reads: [], text: "lands now, in its own instant (EF-8)" };
  if ((m = /^\s*<(Errored|Loading|Show|For)\b/.exec(line))) return { helper: m[1], reads: [], text: SOLID_PRIMS[m[1]] };
  if ((m = /\bset(\w)(\w*)\((untrack|latest)\(/.exec(line)))
    return { helper: m[3], reads: [], text: m[3] === "latest" ? "latest x: the newest value, even while held (R-12)" : `a read in a handler is a snapshot (H-10)` };
  return undefined;
}
