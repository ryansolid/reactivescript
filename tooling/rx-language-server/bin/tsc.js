#!/usr/bin/env node
// `rx-tsc`: TypeScript's own `tsc`, with `.rx` modules in the program (spec/13 TY-1a), for CI and the command line. It
// is Volar's tsc runner (the one `vue-tsc` uses) with the language server's `.rx` plugin, so the editor and the command
// line check the same projection. It takes tsc's arguments (`rx-tsc --noEmit`, `-p`, `--watch`) and reads the
// tsconfig.json's `include`, which must name the `.rx` files. Type errors are placed on the `.rx`.
//
// The crate's own diagnostics (parse errors, else the checker's, with their rules) are reported after TypeScript's, for
// every `.rx` module in the program: a module that does not parse has no projection, so TypeScript alone would pass it.
const path = require("node:path");
const { runTsc } = require("@volar/typescript/lib/quickstart/runTsc");
const { rxLanguagePlugin, analyses } = require("../src/index.js");

const tsc = require.resolve("typescript/lib/tsc");

process.on("exit", code => {
  const watching = process.argv.includes("--watch") || process.argv.includes("-w");
  if (watching) return;
  let errors = 0;
  for (const { file, result } of analyses()) {
    for (const d of result.diagnostics ?? []) {
      errors++;
      const where = d.range ? `${d.range.start.line}:${d.range.start.column + 1}` : "1:1";
      process.stdout.write(`${path.relative(process.cwd(), file)}:${where} - error ${d.code}: ${d.message} (${d.rule})\n`);
    }
  }
  if (errors) {
    process.stdout.write(`\nFound ${errors} ReactiveScript error${errors === 1 ? "" : "s"}.\n`);
    if (!code) process.exitCode = 1;
  }
});

runTsc(tsc, [".rx"], ts => [rxLanguagePlugin(ts)]);
