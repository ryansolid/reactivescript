// AC-1e (STALE_WRITE_BACK) through authored TSX. An action reads likes, waits for the server, then writes back a value
// computed from that earlier read; a like made while it waited is lost. Native Solid runs the buggy TSX and shows the lost
// update; the frontend refuses it with upstream's diagnostic, as the checker refuses the handwritten RX. The functional
// setter is accepted, has the same facts as its RX, and keeps the concurrent like on every backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@solidjs/compiler";
import { buildTsx } from "./build.ts";
import { loadTsxModules } from "./modules.ts";
import { semanticFacts } from "./rx/facts.ts";
import { CheckError, checkModules, compileModules, lowerViews, STRING_RENDERER, type ModuleSet } from "./rx/compiler.ts";
import { createApp, flush, Runtime } from "./rx/runtime.ts";

const BUGGY = `import { createSignal, action } from "solid-js";
import { save } from "./api";

export default function Likes() {
  const [likes, setLikes] = createSignal(0);
  const like = action(function* () {
    const before = likes();
    try {
      yield save();
      setLikes(before + 1);
    } catch (error) {}
  });
  return (
    <section>
      <button onClick={() => like()}>like and save</button>
      <button onClick={() => setLikes((n) => n + 1)}>like here</button>
      <b>{likes()}</b>
    </section>
  );
}`;
const FIXED = BUGGY.replace("    const before = likes();\n", "").replace("setLikes(before + 1)", "setLikes((n) => n + 1)");
const BUGGY_RX = `import { save } from "./api";
export default component Likes() {
  source likes := 0;
  action like() {
    let before = likes;
    try { await save(); likes := before + 1; } catch (error) {}
  }
  <section><button onClick={() => { like() }}>like and save</button><button onClick={() => { likes := n => n + 1 }}>like here</button><b>{"" + likes}</b></section>
}`;
const FIXED_RX = BUGGY_RX.replace("    let before = likes;\n", "").replace("likes := before + 1", "likes := n => n + 1");

const API = "export fn save(): number";
const files = (name: string, text: string): Record<string, string> => ({ [name]: text, "api.d.rx": API });
const load = (name: string, text: string): ModuleSet => {
  const set = loadTsxModules(name, path => files(name, text)[path]);
  assert.deepEqual(set.diags, [], name + " loads");
  return set;
};
/** Upstream's message, at the action's line (6 in the TSX, 4 in the RX). */
const stale = (file: string) => "AC-1e: STALE_WRITE_BACK (AC-1e) " + file +
  ": likes := … after an `await` is computed from likes as it was read before that `await`: whatever changed likes in between";

/** Click "like and save", then "like here" while the save is in flight, then let the save succeed. */
const EXPECTED_FIXED = ["like and savelike here0", "like and savelike here0", "like and savelike here1", "like and savelike here2"];
const EXPECTED_BUGGY_NATIVE = ["like and savelike here0", "like and savelike here0", "like and savelike here1", "like and savelike here1"];

type Driver = { frames: string[]; click: (n: number) => void; answer: () => void; settle: () => Promise<void>; dispose: () => void };
async function script(driver: Driver): Promise<string[]> {
  try {
    for (const step of [() => driver.click(0), () => driver.click(1), () => driver.answer()]) { step(); await driver.settle(); }
    return driver.frames;
  } finally { driver.dispose(); }
}

function interpreted(set: ModuleSet): Driver {
  const rt = new Runtime(set);
  const frames = [rt.step([]).at(-1)!.frame];
  const buttons = (items: any[]): any[] => items.flatMap((i: any) => i.k === "el" && i.tag === "button" ? [i] : buttons(i.children ?? i.inst?.items ?? []));
  return {
    frames,
    click: n => { buttons(rt.view.items)[n].attrs.find((a: any) => a.name === "onClick").node.compute(rt)(); frames.push(rt.handler([]).at(-1)!.frame); },
    answer: () => { frames.push(rt.land('"save:"', 1, false).at(-1)!.frame); },
    settle: async () => {},
    dispose: () => rt.root.dispose(),
  };
}

async function rendered(code: Map<string, string>, entry: string, native: boolean): Promise<string[]> {
  const root = fileURLToPath(new URL("../.out/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(root + "stale-write-");
  const renderer = fileURLToPath(new URL("./test-renderer.ts", import.meta.url));
  try {
    for (const [name, text] of code) writeFileSync(dir + "/" + name, text.replaceAll(STRING_RENDERER, renderer));
    const mod = await import(pathToFileURL(dir + "/" + entry).href);
    const app = createApp();
    (globalThis as any).__staleWriteSave = () => (app.api("save")() as any).first;
    const dispose = app.mount(native ? () => mod.default() : mod.default(app));
    const buttons = (node: any): any[] => node?.tag === "button" ? [node] : (node?.children ?? []).flatMap(buttons);
    const frames: string[] = [];
    const settle = async () => {
      for (let i = 0; i < 3; i++) { await new Promise<void>(done => setImmediate(done)); flush(); }
      frames.push(app.frame());
    };
    await settle();
    return await script({
      frames, settle, dispose,
      click: n => buttons(app.root)[n].props.onClick(),
      answer: () => { const flight = app.flights.get("save:"); assert.ok(flight, "the save is in flight"); flight.resolve(1); },
    });
  } finally {
    delete (globalThis as any).__staleWriteSave;
    rmSync(dir, { recursive: true, force: true });
  }
}
const native = (tsx: string) => rendered(new Map([["native.mts", transform(tsx, { filename: "likes.tsx", generate: "universal", moduleName: STRING_RENDERER }).code
  .replaceAll('"./api"', '"data:text/javascript,export const save=()=>globalThis.__staleWriteSave()"')]]), "native.mts", true);
const compiled = (set: ModuleSet) => { const built = compileModules(set); return rendered(lowerViews(built.files, "universal"), built.entry, false); };

test("stale write-back: native Solid runs the buggy TSX and loses the like made while the save was in flight", async () => {
  assert.deepEqual(await native(BUGGY), EXPECTED_BUGGY_NATIVE);
});

test("stale write-back: the frontend refuses the authored TSX with upstream's STALE_WRITE_BACK, as the checker refuses the RX", () => {
  for (const [name, text, at] of [["likes.tsx", BUGGY, "likes.tsx:6"], ["likes.rx", BUGGY_RX, "likes.rx:4"]]) {
    assert.deepEqual(checkModules(load(name, text)).diags.map(d => d.code), ["STALE_WRITE_BACK"], name);
    assert.throws(() => buildTsx(name, path => files(name, text)[path], { mount: "Likes" }),
      (error: unknown) => error instanceof CheckError && error.message.startsWith(stale(at)), name + " build");
  }
});

test("stale write-back: the functional setter is accepted and has the same facts as the fixed RX", () => {
  assert.notEqual(FIXED, BUGGY);
  assert.notEqual(FIXED_RX, BUGGY_RX);
  const tsx = load("likes.tsx", FIXED), rx = load("likes.rx", FIXED_RX);
  assert.deepEqual(checkModules(tsx).diags, []);
  assert.deepEqual(checkModules(rx).diags, []);
  assert.deepEqual(semanticFacts(tsx), semanticFacts(rx));
});

test("stale write-back: the fixed version keeps the concurrent like on native, compiled and interpreted backends", async () => {
  assert.deepEqual(await native(FIXED), EXPECTED_FIXED, "native Solid");
  assert.deepEqual(await compiled(load("likes.tsx", FIXED)), EXPECTED_FIXED, "compiled TSX");
  assert.deepEqual(await compiled(load("likes.rx", FIXED_RX)), EXPECTED_FIXED, "compiled RX");
  assert.deepEqual(await script(interpreted(load("likes.tsx", FIXED))), EXPECTED_FIXED, "interpreted TSX");
  assert.deepEqual(await script(interpreted(load("likes.rx", FIXED_RX))), EXPECTED_FIXED, "interpreted RX");
});
