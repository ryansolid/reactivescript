// probe: build, open, run steps from a JS file, dumping body text after each
const E = "/tmp/claude-0/-home-user/b0c1a8f0-5828-5b86-a816-75e9c36897f9/scratchpad/rx/eval/";
const { build } = await import(E + "harness/build.mjs");
const { launch, serve } = await import(E + "harness/driver.mjs");
const [dir, stepsFile] = process.argv.slice(2);
const b = await build(dir); if (!b.ok) { console.log(b.output); process.exit(1); }
const server = await serve(b.dist); const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", e => console.log("PAGEERR", e.message));
page.on("console", m => console.log("CONSOLE", m.type(), m.text().slice(0, 300)));
await page.goto(server.url); await page.waitForTimeout(200);
const norm = s => (s ?? "").replace(/\s+/g, " ").trim();
const dump = async (l) => console.log(`--- ${l}\n`, norm(await Promise.race([page.locator("body").textContent(), new Promise(r => setTimeout(() => r("HUNG"), 3000))])), "\n in air:", await Promise.race([page.evaluate(() => globalThis.__flights.pending()), new Promise(r => setTimeout(() => r("HUNG"), 3000))]));
const steps = (await import(stepsFile)).default;
for (const [label, f] of steps) { try { await Promise.race([f(page), new Promise((_, j) => setTimeout(() => j(new Error("step timeout")), 4000))]); } catch (e) { console.log("STEP ERR", e.message.split("\n")[0]); } await page.waitForTimeout(100); await dump(label); }
await browser.close(); server.close(); process.exit(0);
