// The crate's `__rt` JSX read as Solid 2.0 primitives (spec/11 CP-4b); a reading aid, not what runs.

/** The index just past the bracket that closes the one at `open`, skipping strings, templates and comments. */
function close(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === "\\") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      i = code.indexOf("\n", i);
      if (i < 0) return code.length;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return code.length;
}

/** Top-level arguments of the call whose `(` is at `open`. */
function args(code: string, open: number): { list: string[]; end: number } {
  const end = close(code, open);
  const inner = code.slice(open + 1, end - 1);
  const list: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === "\\") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      list.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (inner.slice(start).trim()) list.push(inner.slice(start).trim());
  return { list, end };
}

/** Applies `f` to the code between strings, templates and comments, leaving their contents as written. */
function inCode(code: string, f: (part: string) => string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    let end = -1;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      for (; j < code.length && code[j] !== c; j++) if (code[j] === "\\") j++;
      end = j + 1;
    } else if (c === "/" && code[i + 1] === "/") {
      end = code.indexOf("\n", i);
      if (end < 0) end = code.length;
    }
    if (end < 0) continue;
    out += f(code.slice(from, i)) + code.slice(i, end);
    from = i = end;
    i--;
  }
  return out + f(code.slice(from));
}

/** Rewrites every `name(` call in `code` with `f(args, start, end)`; returning undefined keeps the call. */
function eachCall(code: string, name: string, f: (a: string[], start: number) => string | undefined): string {
  let out = "";
  let from = 0;
  for (let i = code.indexOf(name + "(", from); i >= 0; i = code.indexOf(name + "(", from)) {
    if (/[\w$.]/.test(code[i - 1] ?? "")) {
      out += code.slice(from, i + name.length);
      from = i + name.length;
      continue;
    }
    const open = i + name.length;
    const { list, end } = args(code, open);
    const r = f(list, i);
    out += code.slice(from, i) + (r ?? code.slice(i, end));
    from = end;
  }
  return out + code.slice(from);
}

/** `(X)` → `X` when the parentheses wrap all of it. */
const unparen = (x: string) => {
  x = x.trim();
  return x.startsWith("(") && close(x, 0) === x.length ? x.slice(1, -1).trim() : x;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const unprev = (fn: string) => (/__prev/.test(fn.replace(/^\(__prev\)\s*=>/, "")) ? fn : fn.replace(/^\(__prev\)\s*=>/, "() =>"));
const unseed = (seed: string) => {
  const m = /^__rt\.untrack\(\(\) => ([\s\S]*)\)$/.exec(seed);
  if (!m) return seed;
  const value = unparen(m[1]);
  // createSignal(fn) would derive from fn, so a function-valued seed keeps its untrack
  return /^(\([^)]*\)\s*=>|\w+\s*=>|function|async)/.test(value) ? seed : value;
};

export function solidify(code: string): string {
  const used = new Set<string>();
  const optimistic = new Set<string>();
  const stores = new Set<string>();

  // import aliases: `import { f as w$f }` and `const v$f = w$f;` are one name
  code = code.replace(/(\w+) as w\$\1\b/g, "$1").replace(/^\s*const v\$(\w+) = w\$\1;\n/gm, "");
  code = code.replace(/^[ \t]*__rt\.reg\([^;]*\);\n/gm, "").replace(/^[ \t]*__rt\.hoisted\([^;]*\);\n/gm, "");
  if ((code.match(/\b__o\b/g) ?? []).length === (code.match(/const __o = __rt\.owner\(\);/g) ?? []).length)
    code = code.replace(/^[ \t]*const __o = __rt\.owner\(\);\n/gm, "");

  code = eachCall(code, "__rt.source", (a) => {
    const seed = unseed(a[1] ?? "undefined");
    const prim = /^[[{]/.test(seed.trim()) ? "createStore" : "createSignal";
    if (prim === "createStore") stores.add(JSON.parse(a[0]));
    used.add(prim);
    return `${prim}(${seed})`;
  });
  code = eachCall(code, "__rt.question", (a, at) => {
    const [, fn, opts, mode = "", key] = a;
    const name = JSON.parse(a[0]);
    const flag = (f: string) => new RegExp(`\\b${f}: true`).test(mode);
    const o = opts && opts !== "undefined" ? `, ${opts}` : "";
    const f = unprev(fn);
    if (flag("optimistic") && flag("structured")) return stores.add(name), used.add("createOptimisticStore"), `createOptimisticStore(${f}, ${key ? "[]" : "{}"}${key ? `, { key: ${key} }` : ""})`;
    if (flag("optimistic") && flag("derived")) return used.add("createOptimistic"), `createOptimistic(${f}${o})`;
    if (flag("optimistic")) {
      // a truth signal, and the optimistic layer a guess writes over it
      optimistic.add(name);
      used.add("createSignal").add("createOptimistic");
      void at;
      return `createSignal(${f}${o})`;
    }
    if (flag("structured")) return stores.add(name), used.add("createStore"), `createStore(${f}, {})`;
    used.add("createSignal");
    return `createSignal(${f}${o})`;
  });
  // `const [v$x, w$x] = createSignal(fn)` with a guess: `const [x$truth, setX] = …; const [x, guessX] = createOptimistic(…)`
  for (const name of optimistic) {
    const decl = `const [v$${name}, w$${name}] = createSignal(`;
    const i = code.indexOf(decl);
    if (i < 0) continue;
    const end = close(code, i + decl.length - 1);
    const semi = code[end] === ";" ? end + 1 : end;
    const ind = /[ \t]*$/.exec(code.slice(0, i))![0];
    const call = code.slice(i + decl.length - "createSignal(".length, end);
    code = code.slice(0, i) + `const [${name}$truth, set${cap(name)}] = ${call};\n${ind}const [${name}, guess${cap(name)}] = createOptimistic(() => ${name}$truth());` + code.slice(semi);
  }

  // `x key k = e` (ST-4): the answer as a memo, and a projection over it that keeps each row by its key
  for (let i = code.indexOf("const v$"); i >= 0; i = code.indexOf("const v$", i + 1)) {
    const m = /^const v\$(\w+) = __rt\.keyed\(/.exec(code.slice(i));
    if (!m) continue;
    const { list, end } = args(code, i + m[0].length - 1);
    const semi = code[end] === ";" ? end + 1 : end;
    const ind = /[ \t]*$/.exec(code.slice(0, i))![0];
    const name = m[1];
    stores.add(name);
    used.add("createMemo").add("createProjection");
    code = code.slice(0, i) + `const ${name}$answer = createMemo(${list[2]});\n${ind}const v$${name} = createProjection(() => ${name}$answer(), [], { key: ${list[1]} });` + code.slice(semi);
  }
  // `x = draft(pre x -> seed) { … }` (ST-3): a projection whose function writes its draft
  for (let i = code.indexOf("const v$"); i >= 0; i = code.indexOf("const v$", i + 1)) {
    const m = /^const v\$(\w+) = __rt\.draft\(/.exec(code.slice(i));
    if (!m) continue;
    const { list, end } = args(code, i + m[0].length - 1);
    stores.add(m[1]);
    used.add("createProjection");
    code = code.slice(0, i) + `const v$${m[1]} = createProjection(${list[1]}, ${unseed(list[0])})` + code.slice(end);
  }
  // a draft write: `{ let __t = d; __t[k] = v; }` is `d[k] = v;`
  code = code.replace(/\{\s*let __t = ([\w$]+);\s*__t((?:\[[^\n]*?\]|\.\w+)+) = ([^;\n]+);\s*\}/g, "$1$2 = $3;");
  code = code.replace(/\b__B\.str\(/g, "String(");

  code = eachCall(code, "__rt.memo", (a) => {
    used.add("createMemo");
    return `createMemo(${unprev(a[1])}${a[2] && a[2] !== "undefined" ? `, ${a[2]}` : ""})`;
  });
  code = code.replace(/!__rt\.eq\(/g, "__rt.neq(");
  code = eachCall(code, "__rt.neq", (a) => `((${a[0]}) !== (${a[1]}))`);
  code = eachCall(code, "__rt.eq", (a) => `((${a[0]}) === (${a[1]}))`);
  code = eachCall(code, "__rt.awaited", (a) => a[0]);
  code = eachCall(code, "__rt.show", (a) => a[0]);
  code = eachCall(code, "__rt.snapshot", (a) => (used.add("untrack"), `untrack(${a[0]})`));
  code = eachCall(code, "__rt.refresh", (a) => (used.add("refresh"), `refresh(${a[1]})`));
  code = eachCall(code, "__rt.scopedClass", (a) => `[${a[0]}, ${a[1]}]`);
  for (const h of ["untrack", "latest", "isPending", "affects", "onFlush", "onSettled", "until", "action"])
    code = code.replace(new RegExp(`__rt\\.${h}\\(`, "g"), () => (used.add(h), `${h}(`));

  // `(() => { return X; })()`: what was left of a region's function once its owner line went
  for (let i = code.indexOf("(() => {"); i >= 0; i = code.indexOf("(() => {", i + 1)) {
    const bodyOpen = i + "(() => ".length;
    const bodyEnd = close(code, bodyOpen);
    if (code.slice(bodyEnd, bodyEnd + 3) !== ")()") continue;
    const m = /^\{\s*return ([\s\S]*);\s*\}$/.exec(code.slice(bodyOpen, bodyEnd));
    if (m && !/^\s*\(?\s*$/.test(m[1])) code = code.slice(0, i) + unparen(m[1]) + code.slice(bodyEnd + 3);
  }

  // `=> { return X; }` is `=> X`
  for (let i = code.indexOf("=> {"); i >= 0; i = code.indexOf("=> {", i + 1)) {
    const bodyOpen = i + 3;
    const bodyEnd = close(code, bodyOpen);
    const m = /^\{\s*return ([\s\S]*);\s*\}$/.exec(code.slice(bodyOpen, bodyEnd));
    if (m && !/^\s*\(?\s*$/.test(m[1]) && !/\breturn\b/.test(m[1])) {
      const x = unparen(m[1]);
      code = code.slice(0, bodyOpen) + (x.startsWith("{") ? `(${x})` : x) + code.slice(bodyEnd);
    }
  }
  // a branch's unused item parameter: `{(__item) => X}` is `{X}`
  for (let i = code.indexOf("(__item) => "); i >= 0; i = code.indexOf("(__item) => ", i + 1)) {
    const body = i + "(__item) => ".length;
    const end = "([{".includes(code[body]) ? close(code, body) : code.indexOf("\n", body);
    if (!/\b__item\b/.test(code.slice(body, end < 0 ? undefined : end))) code = code.slice(0, i) + code.slice(body);
  }

  // writers and names
  for (const name of optimistic) code = code.replace(new RegExp(`w\\$${name}\\.guess\\(`, "g"), `guess${cap(name)}(`);
  code = inCode(code, (part) =>
    part
      .replace(/\bw\$(\w+)\.set\(/g, (_, n) => `set${cap(n)}(`)
      .replace(/\bw\$(\w+)\b/g, (_, n) => `set${cap(n)}`)
      .replace(/\ba\$(\w+)\$(\d+)\b/g, (_, n, k) => (k === "0" ? `${n}$await` : `${n}$await${k}`))
      .replace(/\bp\$(\w+)\b/g, (_, n) => `prev${cap(n)}`)
      .replace(/\b[vV]\$(\w+)\b/g, "$1"),
  );
  // a store is read as itself, not called: within the block that declares it
  for (const n of stores) {
    const decl = new RegExp(`const (?:\\[${n}, \\w+\\]|${n}) = create(?:Store|OptimisticStore|Projection)\\(`, "g");
    for (const m of [...code.matchAll(decl)].reverse()) {
      let open = (m.index ?? 0) - 1;
      while (open >= 0 && !(code[open] === "{" && close(code, open) > (m.index ?? 0))) open--;
      const end = open < 0 ? code.length : close(code, open);
      const from = open < 0 ? 0 : open;
      code = code.slice(0, from) + inCode(code.slice(from, end), (part) => part.replace(new RegExp(`(?<![\\w$.])${n}\\(\\)`, "g"), n)) + code.slice(end);
    }
  }

  // JSX text: `type={"button"}` and `{"Clear"}` as plain text where nothing changes by it
  code = code.replace(/=\{("[^"\\{}]*")\}/g, "=$1").replace(/\{"([^"\\{}<>&\n]*[^"\\{}<>&\s])"\}/g, (all, t, at, str) => (/^\S/.test(t) ? t : all));
  // a fragment around one element, or braces around one element, says nothing
  for (let before = ""; before !== code; ) {
    before = code;
    code = code.replace(/<>\s*(<(\w[\w.$]*)\b(?:[^<]|<(?!\/?>))*?<\/\2>|<\w[\w.$]*\b[^<>]*\/>)\s*<\/>/g, "$1");
    code = code.replace(/\{\s*(<(\w[\w.$]*)\b(?:[^<]|<(?!\/?>))*?<\/\2>)\s*\}/g, (all, el, tag, at, str) => (/[>}]\s*$/.test(str.slice(0, at)) ? el : all));
  }

  // the app wrapper, when nothing in it needs the runtime any more
  const wrap = /export default function main\(__rt\) \{\s*const __B = __rt\.B;\s*return \(\) => \{([\s\S]*)return \(?\s*(?:<>\s*)?<(\w+) children=\{\[\]\} \/>\s*(?:<\/>\s*)?\)?;\s*\};\s*\}\s*$/.exec(code);
  if (wrap && !/__rt|__B/.test(wrap[1])) code = code.slice(0, wrap.index) + wrap[1].replace(/^\t\t/gm, "") + `export default ${wrap[2]};\n`;

  for (const c of ["Errored", "Loading", "For", "Show", "Repeat"]) if (new RegExp(`<${c}[\\s>]`).test(code)) used.add(c);
  const head = used.size ? `import { ${[...used].sort().join(", ")} } from "solid-js";\n` : "";
  return head + code;
}
