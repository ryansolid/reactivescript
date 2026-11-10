// ReactiveScript's front end for @solidjs/vite-plugin. The plugin loads it from `@reactivescript/compiler/vite` when
// the project has the package, so `solid()` compiles `.rx` with no option; `solid({ frontends: { ".rx": rx() } })`
// names it explicitly.
//
// The crate (its Node-API build, `src/node.rs`: what `rxc app` does) already hands each module to Solid's compiler
// (spec/11 CP-1), so a `.rx` module comes back as Solid's output for the environment's `generate`, with its source map onto the `.rx` and, on a
// program's entry, the program's stylesheet. Solid's plugin then takes it the way it takes lowered `.tsrx`: primitive
// names, `lazy()`, the HMR refresh pass, server functions (12 SF-7a), the stylesheet as a CSS module.
//
// Entries find themselves. JavaScript imports only a program's entry (its default export mounts the app); an `.rx`
// dependency is a factory over the app (09 MO-1b) that only `.rx` imports. So an `.rx` module imported plainly is an
// entry: the program is checked and compiled whole from it (CP-2), once per target and again when one of its files
// changes. The crate's output imports its dependencies as `./x.rx?rx-dep`, and a dependency is served from the build
// of a program that contains it. A module several programs share is one module: its instance is keyed by its factory
// (11 CP-4b `module`), not by its place in a program.
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { app } = createRequire(import.meta.url)("./index.js");
const DEP = "rx-dep";
// the page each code points to: the package's copy (scripts/guide.mjs), else the repository's
const GUIDE = [path.join(path.dirname(fileURLToPath(import.meta.url)), "guide/diagnostics.md"), path.join(path.dirname(fileURLToPath(import.meta.url)), "../guide/diagnostics.md")].find(existsSync)
  ?? "https://github.com/solidjs/reactivescript/blob/main/guide/diagnostics.md";
const at = d => d.range ? `${d.range.start.line}:${d.range.start.column + 1}` : `${d.line}`;
/** The diagnostics as `rxc check` prints them, then, once per code, where its fix is explained. */
const report = ds => [
  ...ds.map(d => `${d.file}:${at(d)}: error ${d.code} [${d.rule}] ${d.msg}`),
  "",
  ...[...new Set(ds.map(d => d.code))].map(c => `${c}: why, and the fix — ${GUIDE}#${c.toLowerCase()}`),
].join("\n");
const mtime = file => { try { return statSync(file).mtimeMs; } catch { return -1; } };
const isDep = moduleId => new URLSearchParams(moduleId.split("?")[1] ?? "").has(DEP);
// `import __m0 from "./catalog.rx";` → `"./catalog.rx?rx-dep"` (one line each: the module's map is by line, CP-1c)
const tagDeps = code => code.replace(/^(import \w+ from ")(\.{1,2}\/[^"?]*\.rx)(";?)$/gm, `$1$2?${DEP}$3`);

/** @returns {import("@solidjs/vite-plugin").Frontend} */
export default function rx() {
  const builds = new Map();   // entry\0target\0moduleName\0spa → { entry, target, moduleName, spa, out, stamps }
  const fresh = b => [...b.stamps].every(([f, t]) => mtime(f) === t);
  function build(entry, target, moduleName, spa) {
    const key = `${entry}\0${target}\0${moduleName}\0${spa}`;
    const prior = builds.get(key);
    if (prior && fresh(prior)) return prior;
    const out = JSON.parse(app(entry, target, moduleName, spa));
    if (out.modules) out.modules = Object.fromEntries(Object.entries(out.modules).map(([p, m]) => [path.resolve(p), m]));
    const files = out.modules ? Object.keys(out.modules) : out.diagnostics ? [...new Set([entry, ...out.diagnostics.map(d => d.file)])] : [entry];
    const b = { entry, target, moduleName, spa, out, stamps: new Map(files.map(f => [f, mtime(f)])) };
    builds.set(key, b);
    return b;
  }
  /** A dependency: from a build of a program that has it, rebuilt if that program changed. */
  function containing(file, target, moduleName, spa) {
    const has = [...builds.values()].filter(b => b.target === target && b.moduleName === moduleName && b.spa === spa && b.out.modules?.[file]);
    const b = has.find(fresh) ?? has[0];
    if (!b) throw new Error(`${file} is imported as an .rx dependency, but no program built so far contains it`);
    return build(b.entry, target, moduleName, spa);
  }
  return {
    compile(_source, { id, moduleId, solid, addWatchFile }) {
      const file = path.resolve(id);
      const target = solid.generate === "ssr" ? "ssr" : solid.generate === "universal" ? "universal" : "dom";
      const moduleName = solid.moduleName ?? "@solidjs/web";
      // 08 CN-3d: a client-only build (no SSR, nothing hydrates) has nothing to show on a first load nothing holds
      const spa = target === "dom" && solid.hydratable === false;
      const dep = isDep(moduleId);
      const { entry, out } = dep ? containing(file, target, moduleName, spa) : build(file, target, moduleName, spa);
      if (out.diagnostics) throw new Error(report(out.diagnostics));
      if (out.error) throw new Error(out.error);
      const m = out.modules[file];
      for (const p of Object.keys(out.modules)) if (p !== file) addWatchFile(p);
      // CSS-4: the program's stylesheet, linked once, from its entry
      return { code: tagDeps(m.code), map: m.map, css: !dep && file === entry ? out.css : "" };
    },
  };
}
