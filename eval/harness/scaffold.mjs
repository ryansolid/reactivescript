// Makes a working directory for one arm of one task: the brief, the API, the visible tests and the commands the
// agent may run. With --reference, also copies in the reference solution (eval/reference/<task>/<arm>).
// --brief <name> uses tasks/<task>/brief-<name>.md (e.g. `plain`) instead of brief.md. Writes the agent's prompt to
// <dir>/.prompt.
// --base <dir> makes a change task (round 4): it copies an existing app's source files from <dir> into src/, and the
// task's BASE.md (the brief that app was built to) next to BRIEF.md, and the prompt asks for a change, not a new app.
// Round 7's chain steps (tasks/chain1..4, harness/make-chain.mjs) take the previous step's run's src/ as the base.
// --inline-docs (round 5) puts the .rx guide's pages (guide/language.md, guide/async.md, and from round 11
// guide/reference.md) at the end of the .rx
// prompt, so reading them costs no tool calls, and Solid's own agent primer (solid-js/skills/solid-2.0/SKILL.md) at
// the end of the Solid prompt; the React prompt is unchanged.
// For foldkit, the docs are Foldkit's own FOLDKIT.md (create-foldkit-app's template) at the end of the prompt, and the
// Foldkit repository at the installed release's tag readable in docs/foldkit, as Foldkit tells agents to vendor it
// (examples, skills, AGENTS.md, the framework source); FOLDKIT_REPO names the checkout (default ../../foldkit).
// Arms: rx, react, solid (Solid 2 TSX, round 5), foldkit (round 6), vanilla (plain TypeScript and DOM, no framework),
// xstate (React with XState v5 machines, no TanStack Query; 2026-11-11).
// Usage: node harness/scaffold.mjs <task> <rx|react|xstate|solid|foldkit|vanilla> <dir> [--reference] [--brief <name>] [--base <dir>] [--inline-docs]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyContractReference, exact2, newContractDesk, startHere } from "./contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const evalDir = path.resolve(here, "..");
const foldkitRepo = process.env.FOLDKIT_REPO ?? path.resolve(evalDir, "../../foldkit");
// For xstate, the docs are Stately's own (github.com/statelyai/docs, content/docs, the XState v5 pages as .mdx): the
// cheatsheet and @xstate/react's README at the end of the prompt, every page readable in docs/xstate. STATELY_DOCS names the
// checkout (default ../../stately-docs).
const statelyDocs = process.env.STATELY_DOCS ?? path.resolve(evalDir, "../../stately-docs");

export function scaffold(task, arm, dir, { reference = false, brief = null, base = null, inline = false } = {}) {
  const t = path.join(evalDir, "tasks", task);
  dir = path.resolve(dir);
  if (arm === "contract") newContractDesk(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true }); mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(path.join(dir, "arm"), `${arm}\n`);
  cpSync(path.join(t, brief ? `brief-${brief}.md` : "brief.md"), path.join(dir, "BRIEF.md"));
  cpSync(path.join(t, "api.js"), path.join(dir, "src/api.js"));
  // a plain brief names no races, so the agent's copy of the plumbing loses the header that says tests order answers
  const flights = readFileSync(path.join(here, "flights.js"), "utf8");
  writeFileSync(path.join(dir, "src/flights.js"), brief === "plain" ? flights.replace(/^(\/\/.*\n)+\n/, "") : flights);
  cpSync(path.join(t, arm === "rx" ? "api.d.rx" : "api.d.ts"), path.join(dir, `src/${arm === "rx" ? "api.d.rx" : "api.d.ts"}`));
  if (arm === "foldkit") writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", lib: ["ES2022", "DOM"], moduleResolution: "bundler", strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true, esModuleInterop: true, exactOptionalPropertyTypes: true, isolatedModules: true, noEmit: true, allowJs: true, checkJs: false },
    include: ["src/**/*"],
  }, null, 2) + "\n");
  cpSync(path.join(t, "visible.mjs"), path.join(dir, "tests/visible.mjs"));
  cpSync(path.join(t, "fixtures.mjs"), path.join(dir, "tests/fixtures.mjs"));
  if (arm === "react" || arm === "xstate" || arm === "solid" || arm === "vanilla") {
    const jsx = arm === "react" || arm === "xstate" ? { jsx: "react-jsx" } : arm === "solid" ? { jsx: "preserve", jsxImportSource: "@solidjs/web" } : {};
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", ...jsx, strict: true, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, lib: ["ES2022", "DOM", "DOM.Iterable"] },
      include: ["src"],
    }, null, 2) + "\n");
  }
  const cli = path.join(here, "agent-cli.mjs");
  for (const c of ["check", "test"]) writeFileSync(path.join(dir, c), `#!/bin/sh\nexec node ${JSON.stringify(cli)} ${c} "$(dirname "$0")"\n`, { mode: 0o755 });
  // the .rx arm's documentation: the spec, as the earlier agent tests had it (there is nothing about .rx online)
  if (arm === "rx") {
    cpSync(path.join(evalDir, "../spec"), path.join(dir, "docs/spec"), { recursive: true });
    cpSync(path.join(evalDir, "../guide"), path.join(dir, "docs/guide"), { recursive: true });
  }
  if (arm === "foldkit") {
    for (const p of ["README.md", "AGENTS.md", "examples", "skills", "packages/foldkit/src", "packages/create-foldkit-app/templates/base/FOLDKIT.md"])
      cpSync(path.join(foldkitRepo, p), path.join(dir, "docs/foldkit", p), { recursive: true });
    if (!existsSync(path.join(dir, "node_modules"))) symlinkSync(path.join(evalDir, "node_modules"), path.join(dir, "node_modules"));
  }
  if (arm === "xstate") {
    cpSync(path.join(statelyDocs, "content/docs"), path.join(dir, "docs/xstate"), { recursive: true, filter: f => !/[\\/]assets([\\/]|$)/.test(f) && (statSync(f).isDirectory() || /\.(mdx?|json)$/.test(f)) });
    if (!existsSync(path.join(dir, "node_modules"))) symlinkSync(path.join(evalDir, "node_modules"), path.join(dir, "node_modules"));
  }
  // Solid's own docs ship in its package: the agent can read them there before its first build
  if (arm === "solid" && !existsSync(path.join(dir, "node_modules"))) symlinkSync(path.join(evalDir, "node_modules"), path.join(dir, "node_modules"));
  if (reference && arm === "contract") copyContractReference(path.join(evalDir, "reference", task, arm), dir);
  else if (reference) cpSync(path.join(evalDir, "reference", task, arm), path.join(dir, "src"), { recursive: true });
  if (base) {
    cpSync(path.join(t, "BASE.md"), path.join(dir, "BASE.md"));
    // everything the earlier app had (a chain step's base is the previous agent's src/, which may hold more than
    // .rx and .ts files), except the plumbing written above
    const given = new Set(["api.js", "flights.js", "api.d.ts", "api.d.rx"]);
    for (const f of readdirSync(base)) if (!given.has(f) && !f.startsWith(".")) cpSync(path.join(base, f), path.join(dir, "src", f), { recursive: true });
    mkdirSync(path.join(dir, ".scratch"));
  }
  writeFileSync(path.join(dir, ".prompt"), prompt(arm, dir, { plain: brief === "plain", change: !!base, inline }));
  return dir;
}

export function prompt(arm, dir, { plain = false, change = false, inline = false } = {}) {
  const docs = inline && arm !== "react";
  const fill = { ...JSON.parse(readFileSync(path.join(here, "prompt-arms.json"), "utf8"))[docs ? `${arm}-inline` : arm] };
  if (arm === "contract") fill.EXACT2 = exact2();
  fill.BACKEND_NOTE = plain ? "" : " whose answers the tests control";
  let text = readFileSync(path.join(here, change ? "prompt-change.md" : "prompt.md"), "utf8");
  for (let i = 0; i < 2; i++) for (const k of [...Object.keys(fill), "DIR"]) text = text.replaceAll(`{{${k}}}`, k === "DIR" ? dir : fill[k]);
  if (docs && arm === "rx") for (const f of ["language.md", "async.md", "reference.md"]) text += `\n---\n\n${readFileSync(path.join(evalDir, "../guide", f), "utf8")}`;
  if (docs && arm === "foldkit") text += `\n---\n\n${readFileSync(path.join(foldkitRepo, "packages/create-foldkit-app/templates/base/FOLDKIT.md"), "utf8")}`;
  if (docs && arm === "contract") text += `\n---\n\n${startHere()}`;
  if (docs && arm === "xstate") text += `\n---\n\n${readFileSync(path.join(statelyDocs, "content/docs/cheatsheet.mdx"), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "")}\n---\n\n${readFileSync(path.join(evalDir, "node_modules/@xstate/react/README.md"), "utf8")}`;
  if (docs && arm === "solid") text += `\n---\n\n${readFileSync(path.join(evalDir, "node_modules/solid-js/skills/solid-2.0/SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "")}`;
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [task, arm, dir] = process.argv.slice(2);
  const b = process.argv.indexOf("--brief");
  const base = process.argv.indexOf("--base");
  console.log(scaffold(task, arm, dir, { reference: process.argv.includes("--reference"), brief: b > 0 ? process.argv[b + 1] : null, base: base > 0 ? path.resolve(process.argv[base + 1]) : null, inline: process.argv.includes("--inline-docs") }));
}
