// Drives the running playground (`pnpm dev`) in headless Chromium. PLAYGROUND_URL overrides the address and
// CHROMIUM the browser binary.
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const URL = process.env.PLAYGROUND_URL ?? "http://localhost:3020/";
const exe =
  process.env.CHROMIUM ??
  [`${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`].find(existsSync);

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const editor = page.getByTestId("editor");
const js = page.getByTestId("solid");
const settle = () => page.waitForTimeout(300);
const codes = () => page.getByTestId("diag-code").allInnerTexts();
const type = async (text) => {
  await editor.fill(text);
  await page.waitForTimeout(400);
};

await page.goto(URL);
await editor.waitFor();

await check("the featured example reads as Solid primitives: two memos for label", async () => {
  await js.getByText("createMemo", { exact: false }).first().waitFor({ timeout: 5000 });
  const text = await js.innerText();
  assert(text.includes("const [id, setId] = createSignal(1);"), "no createSignal for id");
  assert(text.includes("const label$await = createMemo(() => fetchUser(id()));"), "no memo for the hoisted await");
  assert(text.includes("const label = createMemo(() => label$await()?.name + suffix());"), "no memo for the rest of label");
  assert(text.includes("<Errored") && text.includes("<Loading"), "no Errored/Loading");
  assert(!text.includes("__rt") && !text.includes("_$template"), "runtime or compiled code in the view");
});

await check("Explain notes each line's .rx form and lists the primitives", async () => {
  const notes = await page.getByTestId("note").allInnerTexts();
  assert(notes.some((n) => n.includes("source id := …")), `notes: ${notes.join(" | ")}`);
  assert(notes.some((n) => n.includes("the await in label") && n.includes("reads id")), `notes: ${notes.join(" | ")}`);
  assert(notes.some((n) => n.includes("equation label") && n.includes("suffix")), `notes: ${notes.join(" | ")}`);
  const table = await page.getByTestId("explain").innerText();
  assert(table.includes("createMemo") && table.includes("an equation x = e"), `table: ${table}`);
  await page.getByTestId("explain-toggle").uncheck();
  assert((await page.getByTestId("note").count()) === 0, "notes still shown with Explain off");
  await page.getByTestId("explain-toggle").check();
});

await check("an object source reads as createStore", async () => {
  await type(`export default component App() {\n  source person := { first: "Ada", last: "Lovelace" }\n  <p>{person.first}</p>\n}\n`);
  const text = await js.innerText();
  assert(text.includes("const [person, setPerson] = createStore({"), `no createStore:\n${text}`);
  assert(text.includes("person?.first") && !text.includes("person()"), "the store is called like a signal");
});

await check("the projection example reads as createProjection, keyed and draft", async () => {
  await page.getByTestId("example").selectOption("projection");
  await js.getByText("createProjection", { exact: false }).first().waitFor({ timeout: 5000 });
  const text = await js.innerText();
  assert(text.includes('const open = createProjection(() => open$answer(), [], { key: "id" });'), `no keyed projection:\n${text}`);
  assert(text.includes("const marks = createProjection((d) => {") && text.includes("d[String(picked())] = true;"), `no draft projection:\n${text}`);
  assert(text.includes("<For each={open}>"), "the projection is called like a signal");
  const notes = await page.getByTestId("note").allInnerTexts();
  assert(notes.some((n) => n.includes("open key id = …")), `notes: ${notes.join(" | ")}`);
  assert(notes.some((n) => n.includes("marks = draft(pre marks -> seed)")), `notes: ${notes.join(" | ")}`);
});

await check("typing updates the compiled output live", async () => {
  await type(`export default component App() {
  source count := 0
  tripled = count * 3
  <button onClick={() => { count := count + 1 }}>{tripled}</button>
}
`);
  const text = await js.innerText();
  assert(text.includes("const tripled = createMemo(() => count() * 3);"), `the new equation is not in the output:\n${text}`);
  assert((await codes()).length === 0, `unexpected diagnostics: ${await codes()}`);
  await type((await editor.inputValue()).replace("count * 3", "count * 4"));
  assert((await js.innerText()).includes("count() * 4"), "the edit did not reach the output");
});

await check("`double := 4` shows WRITE_TO_NON_SOURCE, with its rule and a guide link", async () => {
  await type(`export default component App() {
  source count := 0
  double = count * 2
  <button onClick={() => { double := 4 }}>{double}</button>
}
`);
  const link = page.getByTestId("diag-code").first();
  await link.waitFor();
  assert((await codes()).includes("WRITE_TO_NON_SOURCE"), `codes: ${await codes()}`);
  const href = await link.getAttribute("href");
  assert(href.endsWith("guide/diagnostics.md#write_to_non_source"), `href: ${href}`);
  const row = await page.getByTestId("diagnostics").innerText();
  assert(row.includes("[W-1]") && row.includes("double is an equation"), `row: ${row}`);
  assert(await page.locator(".output.stale").count(), "the output is not marked stale");
});

await check("every example compiles and reads as Solid primitives", async () => {
  const ids = await page.getByTestId("example").locator("option:not([disabled])").evaluateAll((os) => os.map((o) => o.value));
  assert(ids.length >= 5, `only ${ids.length} examples`);
  for (const id of ids) {
    await page.getByTestId("example").selectOption(id);
    await settle();
    assert((await codes()).length === 0, `${id}: ${await codes()}`);
    assert(!(await page.locator(".output.stale").count()), `${id}: output stale`);
    const text = await js.innerText();
    assert(/create(Signal|Store)\(/.test(text) && !text.includes("__rt"), `${id}: not shown as Solid primitives:\n${text}`);
  }
});

await check("an edited program survives a reload through the URL hash", async () => {
  await type(`export default component App() {\n  source shared := 41\n  <p>{shared + 1}</p>\n}\n`);
  await page.waitForTimeout(500);
  assert(page.url().includes("#code="), `url: ${page.url()}`);
  await page.reload();
  await editor.waitFor();
  assert((await editor.inputValue()).includes("source shared := 41"), "the program did not come back");
  await js.getByText("createSignal(41)", { exact: false }).waitFor({ timeout: 5000 });
});

await check("a program of two .rx modules shows both, and adding a file is kept in the URL", async () => {
  await page.getByTestId("example").selectOption("source");
  page.once("dialog", (d) => d.accept("util.rx"));
  await page.getByTitle("Add a file").click();
  await type("export bump = 10\n");
  await page.getByRole("button", { name: "main.rx", exact: true }).click();
  await type(`import { bump } from "./util.rx"\n\nexport default component App() {\n  source n := 0\n  total = n + bump\n  <p>{total}</p>\n}\n`);
  await js.getByText("// /util.rx", { exact: false }).waitFor({ timeout: 5000 });
  const text = await js.innerText();
  assert(text.includes("const total = createMemo("), `entry not shown as primitives:\n${text}`);
  assert(!(await page.getByTestId("solid-error").count()), await page.getByTestId("solid-error").innerText().catch(() => ""));
  await page.waitForTimeout(500);
  assert(page.url().includes("#code="), `the added file is not in the URL: ${page.url()}`);
});

await check("no uncaught page errors", async () => {
  assert(pageErrors.length === 0, pageErrors.join("\n"));
});

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
