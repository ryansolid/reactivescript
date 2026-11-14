// ReactiveScript's front end for @solidjs/vite-plugin. The plugin loads it from `@reactivescript/compiler/vite` when
// the project has the package, so `solid()` compiles `.rx` with no option; `solid({ frontends: { ".rx": rx() } })`
// names it explicitly.
//
// The crate (its Node-API build, `src/node.rs`: what `rxc app` does) already hands each module to Solid's compiler
// (spec/11 CP-1), so a `.rx` module comes back as Solid's output for the environment's `generate`, with its source map onto the `.rx` and
// its own stylesheet. Solid's plugin then takes it the way it takes lowered `.tsrx`: primitive
// names, `lazy()`, the HMR refresh pass, server functions (12 SF-7a), the stylesheet as a CSS module.
//
// Entries find themselves. JavaScript imports only a program's entry (its default export mounts the app); an `.rx`
// dependency is a factory over the app (09 MO-1b) that only `.rx` imports. So an `.rx` module imported plainly is an
// entry: the program is checked and compiled whole from it (CP-2), once per target and again when one of its files
// changes. The crate's output imports its dependencies as `./x.rx?rx-dep`, and a dependency is served from the build
// of a program that contains it. A module several programs share is one module: its instance is keyed by its factory
// (11 CP-4b `module`), not by its place in a program.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

const RX_IMPORT = /^import\b[^"']*?\bfrom\s+(["'])(\.{1,2}\/[^"'?]*\.rx)\1/gm;
/** The `.rx` files under `root` from which `file` is reached by imports: first those no other `.rx` file imports. */
function entriesOf(file, root) {
  const importers = new Map();
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".rx")) for (const [, , spec] of readFileSync(p, "utf8").matchAll(RX_IMPORT)) {
        const dep = path.resolve(path.dirname(p), spec);
        importers.set(dep, [...(importers.get(dep) ?? []), p]);
      }
    }
  };
  walk(root);
  const seen = new Set([file]);
  for (const f of seen) for (const i of importers.get(f) ?? []) seen.add(i);
  seen.delete(file);
  const top = f => !importers.has(f);
  return [...seen].sort().sort((a, b) => top(b) - top(a));
}

/** A dependency's factory, wrapped for hot updates (the runtime's `hot` entry); lines are only added after the module's. */
function hotFooter(code, hot) {
  // the code's own hash: a version re-run for an import's change, with its own code unchanged, reloads
  const meta = { ...hot, code: createHash("sha1").update(code).digest("hex").slice(0, 16) };
  const wrapped = code.replace(/^export default function module\(__rt\)/m, "function module(__rt)");
  if (wrapped === code) return code;
  return `${wrapped}
import { hotModule as __rxHotModule } from "@reactivescript/runtime/hot";
const __rxHot = __rxHotModule(import.meta.hot, module, ${JSON.stringify(meta)});
export default __rxHot.factory;
if (import.meta.hot) import.meta.hot.accept(__rxHot.accept);
`;
}

const hasHotRuntime = new Map();
/** Whether the project's `@reactivescript/runtime` has the `hot` entry the footer imports (0.3.1 and older do not). */
function hotRuntime(root) {
  if (!hasHotRuntime.has(root)) {
    let ok = true;
    try { createRequire(path.join(root, "package.json")).resolve("@reactivescript/runtime/hot"); } catch { ok = false; }
    hasHotRuntime.set(root, ok);
  }
  return hasHotRuntime.get(root);
}

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
    if (out.modules) for (const f of files) if (f !== path.resolve(entry)) dependencies.add(f);
    const b = { entry, target, moduleName, spa, out, stamps: new Map(files.map(f => [f, mtime(f)])) };
    builds.set(key, b);
    return b;
  }
  const restyling = new Set();   // dependencies whose stylesheet the plugin is about to ask for, after hotUpdate
  const dependencies = new Set();   // every file a program built so far held as a dependency, kept when its program fails
  const built = (file, target, moduleName, spa) =>
    [...builds.values()].filter(b => b.target === target && b.moduleName === moduleName && b.spa === spa && b.out.modules?.[file]);
  /** A dependency: from a build of a program that has it, rebuilt if that program changed. */
  function containing(file, target, moduleName, spa, root) {
    const has = built(file, target, moduleName, spa);
    const b = has.find(fresh) ?? has[0];
    if (b) return build(b.entry, target, moduleName, spa);
    // the entry's compile was skipped (Vitest's `fsModuleCache` served it), so find the program from the files
    let failed;
    for (const entry of entriesOf(file, root)) {
      const found = build(entry, target, moduleName, spa);
      if (found.out.modules?.[file]) return found;
      if (!failed && found.out.diagnostics) failed = found;   // the program holds it but does not compile: report why
    }
    if (failed) return failed;
    throw new Error(`${file} is imported as an .rx dependency, but no program under ${root} contains it`);
  }
  return {
    // A dependency hot-swaps (rt-hot.ts) when no other module of any program that holds it compiles differently and its
    // text outside its components' bodies is unchanged; then the entry, which watches every module of its program, is left
    // out of the update, so the page keeps its state. Otherwise Vite's list stands, and the entry reloads the page.
    hotUpdate({ file, modules }) {
      file = path.resolve(file);
      // the plugin compiles the changed file next, by its path alone, for its stylesheet
      if (dependencies.has(file)) restyling.add(file);
      const holding = [...builds.values()].filter(b => b.out.modules?.[file]);
      if (!holding.length) return;
      for (const b of holding) {
        const before = b.out, after = build(b.entry, b.target, b.moduleName, b.spa).out;
        const was = before.modules[file].hot, now = after.modules?.[file]?.hot;
        if (!was || !now || was.top !== now.top || was.components.join() !== now.components.join()) return;
        const paths = new Set([...Object.keys(before.modules), ...Object.keys(after.modules)]);
        for (const p of paths) if (p !== file && before.modules[p]?.code !== after.modules[p]?.code) return;
      }
      return modules.filter(m => isDep(m.id ?? m.url ?? ""));
    },
    compile(_source, { id, moduleId, root, solid, addWatchFile, hot }) {
      const file = path.resolve(id);
      const target = solid.generate === "ssr" ? "ssr" : solid.generate === "universal" ? "universal" : "dom";
      const moduleName = solid.moduleName ?? "@solidjs/web";
      // 08 CN-3d: a client-only build (no SSR, nothing hydrates) has nothing to show on a first load nothing holds
      const spa = target === "dom" && solid.hydratable === false;
      const dep = isDep(moduleId) || restyling.delete(file);
      const projectRoot = path.resolve(root ?? process.cwd());
      const { out } = dep ? containing(file, target, moduleName, spa, projectRoot) : build(file, target, moduleName, spa);
      if (out.diagnostics) throw new Error(report(out.diagnostics));
      if (out.error) throw new Error(out.error);
      const m = out.modules[file];
      for (const p of Object.keys(out.modules)) if (p !== file) addWatchFile(p);
      // CSS-4: each module links its own stylesheet, so a module several programs share links it once
      return { code: dep && hot && m.hot && hotRuntime(projectRoot) ? hotFooter(tagDeps(m.code), m.hot) : tagDeps(m.code), map: m.map, css: m.css ?? "" };
    },
  };
}
