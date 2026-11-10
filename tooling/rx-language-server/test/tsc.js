// `rx-tsc` (bin/tsc.js) on a copy of examples/shop: a clean program passes; a TypeScript type error, a parse error and a
// checker error each fail it, placed on the .rx. Same prerequisites as test/run.js.
//   node test/tsc.js            VERBOSE=1 prints each run's output
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "../../..");
const ws = path.join(__dirname, "../.test/tsc");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
for (const f of fs.readdirSync(path.join(repo, "examples/shop"))) fs.copyFileSync(path.join(repo, "examples/shop", f), path.join(ws, f));
fs.writeFileSync(path.join(ws, "api.d.ts"), [
  "export declare function checkout(items: { id: number; qty: number }[], coupon: string): Promise<{ id: number }>;",
  "export declare function fetchProducts(): Promise<{ id: number; name: string; price: number }[]>;",
  "export declare function validateCoupon(code: string): Promise<number>;",
  "",
].join("\n"));
fs.symlinkSync(path.join(repo, "ref/node_modules"), path.join(ws, "node_modules"), "dir");
fs.writeFileSync(path.join(ws, "tsconfig.json"), JSON.stringify({
  compilerOptions: { jsx: "preserve", jsxImportSource: "@solidjs/web", strict: true, noImplicitAny: false, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, lib: ["ES2022", "DOM"], types: [] },
  include: ["*.rx", "*.ts"],
}, null, 2));

const original = Object.fromEntries(fs.readdirSync(ws).filter(f => f.endsWith(".rx")).map(f => [f, fs.readFileSync(path.join(ws, f), "utf8")]));
function run(edit) {
  for (const [f, t] of Object.entries(original)) fs.writeFileSync(path.join(ws, f), t);
  if (edit) fs.writeFileSync(path.join(ws, edit.file), edit.text(original[edit.file]));
  const r = spawnSync(process.execPath, [path.join(__dirname, "../bin/tsc.js")], { cwd: ws, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

let pass = 0, fail = 0;
function check(name, ok, got) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok || process.env.VERBOSE ? `\n      ${JSON.stringify(got).slice(0, 2000)}` : ""}`);
}

const clean = run();
check("the shop passes", clean.status === 0 && clean.out.trim() === "", clean);

const type = run({ file: "cart.rx", text: t => t.replace("qtyOf(p.id)", 'qtyOf("x")') });
const typeLine = original["cart.rx"].slice(0, original["cart.rx"].indexOf("qtyOf(p.id)")).split("\n").length;
check("a type error fails, on the .rx line", type.status !== 0 && new RegExp(`cart\\.rx\\(${typeLine},\\d+\\): error TS2345`).test(type.out), type);

const parse = run({ file: "catalog.rx", text: t => t + "\nexport fn broken( {\n" });
check("a parse error fails (no projection, so TypeScript alone would pass it)", parse.status !== 0 && /catalog\.rx:\d+:\d+ - error PARSE/.test(parse.out), parse);

const write = run({ file: "main.rx", text: t => t + "\naction wipe() { products := [] }\n" });
check("a checker error fails, with its rule", write.status !== 0 && /main\.rx:\d+:\d+ - error WRITE_TO_NON_SOURCE: .*\(MO-2\)/.test(write.out), write);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
