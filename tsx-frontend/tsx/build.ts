import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTsxModules } from "./modules.ts";
import { selectEntry } from "./rx/ast.ts";
import { checkModules } from "./rx/compiler.ts";
import { CheckError } from "./rx/compiler.ts";
import { compileModules } from "./rx/compiler.ts";
import { lowerViews, type Target } from "./rx/compiler.ts";

/** The same checked module graph and Solid backends for both authored syntaxes. */
export function buildTsx(entry: string, read: (path: string) => string | undefined,
  options: { target?: Target; mount?: string } = {}) {
  const set = loadTsxModules(entry, read);
  if (set.diags.length) throw new CheckError(set.diags);
  // The entry is the entry module's default component (MO-1c); --mount selects an exported component as that entry.
  if (options.mount) selectEntry(set.programs.get(set.entry)!, options.mount);
  const checked = checkModules(set);
  if (checked.diags.length) throw new CheckError(checked.diags);
  const compiled = compileModules(set);
  return { set, signatures: checked.sigs, entry: compiled.entry,
    files: lowerViews(compiled.files, options.target ?? "universal") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const input = args.shift();
    if (!input || input.startsWith("--")) throw new Error("Usage: npm run build:tsx -- entry.tsx --out directory [--mount App] [--target universal|dom|ssr]");
    const options: { mount?: string; target?: Target } = {};
    let out: string | undefined;
    while (args.length) {
      const name = args.shift(); const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + name);
      if (name === "--out") out = value;
      else if (name === "--mount") options.mount = value;
      else if (name === "--target" && ["universal", "dom", "ssr"].includes(value)) options.target = value as Target;
      else throw new Error("Unknown option or target: " + name + " " + value);
    }
    if (!out) throw new Error("--out directory is required");
    const result = buildTsx(resolve(input), path => {
      try { return readFileSync(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }, options);
    mkdirSync(resolve(out), { recursive: true });
    for (const [name, code] of result.files) writeFileSync(resolve(out, name), code);
    console.log(resolve(out, result.entry));
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
