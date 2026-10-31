import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { buildTsx } from "./build.ts";
import { CheckError } from "./rx/compiler.ts";

const source = 'import { createSignal } from "solid-js"; export function Counter() { const [n, setN] = createSignal(0); return <button onClick={() => setN(n()+1)}>{n()}</button>; }';

for (const target of ["universal", "dom", "ssr"] as const) {
  test("build uses Solid's " + target + " backend after checking the shared AST", () => {
    const result = buildTsx("main.tsx", path => path === "main.tsx" ? source : undefined, { target, mount: "Counter" });
    assert.equal(result.entry, "main.mjs");
    assert.ok(result.signatures.has("main.tsx"));
    assert.ok(result.files.get(result.entry)?.includes("export default function main"));
    assert.doesNotThrow(() => transformSync(result.files.get(result.entry)!, { loader: "js" }), "JSX must be lowered");
  });
}

test("exports do not mount without an explicit selection", () => {
  const result = buildTsx("main.tsx", () => source);
  assert.deepEqual(result.set.programs.get("main.tsx")!.view, []);
});

test("an unknown component selection is refused", () => {
  assert.throws(() => buildTsx("main.tsx", () => source, { mount: "Missing" }), /No exported component Missing/);
});

test("a missing entry cannot produce an empty emitted build", () => {
  assert.throws(() => buildTsx("missing.tsx", () => undefined), CheckError);
});

test("shared-checker errors stop emission", () => {
  assert.throws(() => buildTsx("main.rx", path => path === "main.rx" ? "value = missing; <p>{value}</p>" : undefined), CheckError);
});

test("CLI checks a TSX entry and writes the selected target's module factories", () => {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "tsx-cli-");
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "tsx/build.ts", "tsx/fixtures/counter.tsx",
      "--mount", "Counter", "--target", "dom", "--out", dir], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /main.mjs/);
    assert.match(readFileSync(dir + "/main.mjs", "utf8"), /export default function main/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI rejects unknown options instead of silently changing the build", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "tsx/build.ts", "tsx/fixtures/counter.tsx", "--target", "unknown", "--out", "unused"],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option or target/);
});
