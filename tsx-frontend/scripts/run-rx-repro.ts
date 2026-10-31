// Runs a handwritten RX reproduction (a directory with main.rx and any modules it imports) on the pinned upstream:
// prints the checker diagnostics, the reference interpreter's first settled frame and the compiled frame.
// Usage: node --experimental-strip-types --conditions=browser --conditions=development scripts/run-rx-repro.ts DIR
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkModules, compileModules, loadModules, lowerViews, STRING_RENDERER } from "../tsx/rx/compiler.ts";
import { createApp, flush, Runtime } from "../tsx/rx/runtime.ts";

const dir = resolve(process.argv[2] ?? ".");
const read = (p: string) => existsSync(dir + "/" + p) ? readFileSync(dir + "/" + p, "utf8") : undefined;
const set = loadModules("main.rx", read);
const diags = [...set.diags, ...checkModules(set).diags];
console.log("diagnostics: " + (diags.length ? diags.map(d => d.code + " " + (d.file ?? "") + ":" + d.line + " " + d.msg.slice(0, 160)).join("\n  ") : "none"));
if (!diags.length) {
  console.log("interpreter: " + new Runtime(set).step([]).at(-1)!.frame);
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const out = mkdtempSync(root + "repro-");
  const renderer = fileURLToPath(new URL("../tsx/test-renderer.ts", import.meta.url));
  try {
    const built = compileModules(set);
    for (const [name, code] of lowerViews(built.files, "universal")) writeFileSync(out + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(out + "/" + built.entry).href);
    const app = createApp();
    const dispose = app.mount(mod.default(app));
    for (let i = 0; i < 6; i++) { await new Promise<void>(r => setImmediate(r)); flush(); }
    console.log("compiled:    " + app.frame());
    dispose();
  } finally { rmSync(out, { recursive: true, force: true }); }
}
