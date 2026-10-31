import test from "node:test";
import assert from "node:assert/strict";
import { compile, compileModules } from "./rx/compiler.ts";
import { loadModules } from "./rx/compiler.ts";
import { parseProgram } from "./rx/compiler.ts";

const question = "source data: { n: number } = { n: 1 }\n";

function structured(output: string): boolean {
  const lines = output.split("\n").filter(line => line.includes('__rt.qsource("data",'));
  assert.equal(lines.length, 1);
  return lines[0].includes("structured: true");
}

test("typed read-only questions stay structured across shadowed component writes", () => {
  const source = question + `
    component Other(props) {
      source data := 0
      action change() { data := 1 }
      <button onClick={() => change()}>change</button>
    }
    export default component App() { <p>{data.n}</p> }
  `;
  assert.equal(structured(compile(parseProgram(source))), true);
});

test("typed read-only questions stay structured across shadowed branch writes", () => {
  const source = question + `
    source show := true
    export default component App() { <div>{if show {
      source data := 0
      action change() { data := 1 }
      <button onClick={() => change()}>change</button>
    } else { <p>{data.n}</p> }}</div> }
  `;
  assert.equal(structured(compile(parseProgram(source))), true);
});

test("root-written questions retain the supported atomic lowering", () => {
  const source = question + `
    action change() { data := { n: 2 } }
    export default component App() { <p>{data.n}</p> }
  `;
  assert.equal(structured(compile(parseProgram(source))), false);
});

test("a shadowed context root write does not reach another provision", () => {
  const source = question + `
    context current: source { n: number }
    provide current = data
    component Other(props) {
      context current: source number
      source count := 0
      provide current = count
      action change() { use current := 1 }
      <button onClick={() => change()}>change</button>
    }
    export default component App() { <p>{data.n}</p> }
  `;
  assert.equal(structured(compile(parseProgram(source))), true);
});

test("root writes through an imported context alias reach the provided question", () => {
  const files = new Map([
    ["context.rx", "export context current: source { n: number }"],
    ["main.rx", `
      import { change } from "./writer.rx"
      import { current as provided } from "./context.rx"
      ${question}
      provide provided = data
      <p>{data.n}</p>
    `],
    ["writer.rx", `
      import { current as target } from "./context.rx"
      export action change() { use target := { n: 2 } }
    `],
  ]);
  const modules = loadModules("main.rx", path => files.get(path));
  assert.deepEqual(modules.diags, []);
  const output = [...compileModules(modules).files.values()].join("\n");
  assert.equal(structured(output), false);
});
