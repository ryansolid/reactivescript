// Demo for review (not a parity claim beyond its script): an authored Solid 2 issue tracker,
// tsx/fixtures/demo/tracker.tsx, and its handwritten RX counterpart, tracker.rx. Both must have the same canonical
// checker facts, a deliberate read-mode change must still be a fact difference, and every backend must render the
// same exact frames for one scripted session: the RX interpreter (TSX-derived and handwritten), the RX compiler for
// both programs, and native Solid's universal renderer. Assignment requests are controllable flights.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { loadTsxModules } from "./modules.ts";
import { semanticFacts } from "./rx/facts.ts";
import { compileModules, lowerViews, STRING_RENDERER, type ModuleSet } from "./rx/compiler.ts";
import { createApp, flush, Runtime } from "./rx/runtime.ts";

const fixture = (name: string) => readFileSync(new URL("./fixtures/demo/" + name, import.meta.url), "utf8");
const load = (name: string, text = fixture(name)): ModuleSet => {
  const files: Record<string, string> = { [name]: text, "api.d.rx": "export fn assignIssue(id: number): string" };
  const set = loadTsxModules(name, path => files[path]);
  assert.deepEqual(set.diags, [], name + " loads and checks");
  return set;
};
const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
const outRoot = fileURLToPath(new URL("../.out/", import.meta.url));

/** Click the n-th rendered button (0 is the filter, then one "take" per visible row), or answer an issue's request. */
type Step = { click: number } | { answer: number; owner?: string; failure?: string };
type Answer = Extract<Step, { answer: number }>;
type Driver = { frame: () => string; click: (n: number) => void; answer: (step: Answer) => void; settle: () => Promise<void>; dispose: () => void };

const SCRIPT: Step[] = [
  { click: 1 },                            // take "Crash on save": the claim shows at once as "me"
  { answer: 1, owner: "dev" },             // success commits the server's owner
  { click: 2 },                            // take "Slow search"
  { answer: 2, failure: "offline" },       // the request fails: roll back to "ana" and explain
  { click: 0 },                            // filter to open issues
  { click: 1 },                            // take "Typo in footer": it leaves the open view at once
  { answer: 3, owner: "dev" },             // success: nothing open, so the fallback stays
];
const EXPECTED = [
  "Filter: all2 openCrash on save: nobodytakeSlow search: anatakeTypo in footer: nobodytake",
  "Filter: all1 openCrash on save: metakeSlow search: anatakeTypo in footer: nobodytake",
  "Filter: all1 openCrash on save: devtakeSlow search: anatakeTypo in footer: nobodytake",
  "Filter: all1 openCrash on save: devtakeSlow search: metakeTypo in footer: nobodytake",
  "Filter: all1 openCrash on save: devtakeSlow search: anatakeTypo in footer: nobodytakeCould not assign #2",
  "Filter: open1 openTypo in footer: nobodytakeCould not assign #2",
  "Filter: open0 openNothing to triageCould not assign #2",
  "Filter: open0 openNothing to triage",
];

async function session(driver: Driver): Promise<string[]> {
  try {
    const frames = [driver.frame()];
    for (const step of SCRIPT) {
      if ("click" in step) driver.click(step.click); else driver.answer(step);
      await driver.settle();
      frames.push(driver.frame());
    }
    return frames;
  } finally { driver.dispose(); }
}

function interpreted(set: ModuleSet): Driver {
  const rt = new Runtime(set);
  let frame = rt.step([]).at(-1)!.frame;
  const found = (items: any[]): any[] => items.flatMap((item: any) => item.k === "el" && item.tag === "button" ? [item]
    : found(item.children ?? item.inst?.items ?? item.committed?.inst?.items ?? item.committedRows?.flatMap((r: any) => r.inst.items) ?? []));
  return {
    frame: () => frame,
    click: n => {
      const handler = found(rt.view.items)[n]?.attrs.find((a: any) => a.name === "onClick")?.node;
      assert.ok(handler, "the interpreter exposes authored button " + n);
      handler.compute(rt)();
      frame = rt.handler([]).at(-1)!.frame;
    },
    answer: step => {
      frame = rt.land('"assignIssue:' + step.answer + '"', step.failure ? new Error(step.failure) : step.owner, !!step.failure).at(-1)!.frame;
    },
    settle: async () => {},
    dispose: () => rt.root.dispose(),
  };
}

async function rendered(files: Map<string, string>, entry: string, native: boolean): Promise<string[]> {
  mkdirSync(outRoot, { recursive: true });
  const dir = mkdtempSync(outRoot + "demo-");
  try {
    for (const [name, code] of files) writeFileSync(dir + "/" + name, code.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + entry).href);
    const app = createApp();
    // Native Solid imports ./api as plain JS; route it to the same controllable flights the compiled RX uses.
    (globalThis as any).__demoAssignIssue = (...args: unknown[]) => (app.api("assignIssue")(...args) as any).first;
    const buttons = (node: any): any[] => node?.tag === "button" ? [node] : (node?.children ?? []).flatMap(buttons);
    let frame = "";
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>(done => setImmediate(done));
        flush();
      }
      frame = app.frame();
    };
    const dispose = app.mount(native ? () => mod.default() : mod.default(app));
    await settle();
    assert.equal(app.flights.size, 0, "no assignment is requested before a click");
    return await session({
      frame: () => frame,
      click: n => {
        const button = buttons(app.root)[n];
        assert.equal(typeof button?.props.onClick, "function", "button " + n + " has its authored handler");
        button.props.onClick();
      },
      answer: step => {
        const flight = app.flights.get("assignIssue:" + step.answer);
        assert.ok(flight, "issue " + step.answer + " has an open assignment request");
        if (step.failure) flight.reject(new Error(step.failure)); else flight.resolve(step.owner);
      },
      settle,
      dispose,
    });
  } finally {
    delete (globalThis as any).__demoAssignIssue;
    rmSync(dir, { recursive: true, force: true });
  }
}

const compiled = (set: ModuleSet) => {
  const built = compileModules(set);
  return rendered(lowerViews(built.files, "universal"), built.entry, false);
};

test("demo tracker: TSX and handwritten RX have the same canonical checker facts", () => {
  const tsx = semanticFacts(load("tracker.tsx"));
  assert.deepEqual(tsx.diagnostics, []);
  const computations = tsx.modules[0].computations;
  const memo = computations.filter(c => c.kind === "memo");
  assert.ok(memo.some(c => c.reads.some(r => r.endsWith("::source:mode tracked"))), "the visible rows track the filter");
  const claim = computations.find(c => c.kind === "action");
  assert.ok(claim, "claim is an explicit action");
  assert.ok(claim.writes.some(w => w.endsWith("::source:shown? optimistic")), "the claim is an optimistic write to the shown list");
  assert.ok(claim.writes.some(w => w.endsWith("::source:issues write path")), "success writes the store path");
  assert.ok(claim.calls.some(c => c.endsWith("::import:assignIssue!io")), "the action calls the request");
  assert.ok(computations.some(c => c.kind === "handler" && c.at === "IssueRow onAssign" && c.calls.some(x => x.endsWith("::action:claim!io"))),
    "the row callback invokes the action");
  assert.deepEqual(tsx, semanticFacts(load("tracker.rx")));
});

test("demo tracker: snapshotting the filter in the handwritten RX is a fact difference, not normalized away", () => {
  const rx = fixture("tracker.rx");
  const changed = rx.replace('issue => mode == "all"', 'issue => peek(mode) == "all"');
  assert.notEqual(changed, rx, "the variant changes one read");
  const variant = semanticFacts(load("tracker.rx", changed));
  assert.ok(variant.modules[0].computations.some(c => c.kind === "memo" && c.reads.some(r => r.endsWith("::source:mode snapshot"))));
  assert.notDeepEqual(semanticFacts(load("tracker.tsx")), variant);
});

test("demo tracker frames: native Solid", async () => {
  const code = transform(fixture("tracker.tsx"), { filename: "tracker.tsx", generate: "universal", moduleName: STRING_RENDERER }).code
    .replaceAll('"./api"', '"data:text/javascript,export const assignIssue=(...args)=>globalThis.__demoAssignIssue(...args)"');
  assert.deepEqual(await rendered(new Map([["native.mts", code]]), "native.mts", true), EXPECTED);
});

test("demo tracker frames: compiled TSX", async () => {
  assert.deepEqual(await compiled(load("tracker.tsx")), EXPECTED);
});

test("demo tracker frames: compiled handwritten RX", async () => {
  assert.deepEqual(await compiled(load("tracker.rx")), EXPECTED);
});

test("demo tracker frames: interpreted TSX", async () => {
  assert.deepEqual(await session(interpreted(load("tracker.tsx"))), EXPECTED);
});

test("demo tracker frames: interpreted handwritten RX", async () => {
  assert.deepEqual(await session(interpreted(load("tracker.rx"))), EXPECTED);
});
