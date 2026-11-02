// Legal-hold variants (PREREG-desk-10 grading rule): the intermediate assertion is logged, not asserted; the
// frame it expected must show once the action in flight lands.
import { D1, D3, OPEN } from "/home/claude/reactivescript/eval/tasks/desk9/fixtures.mjs";
import { selected, rename } from "/home/claude/reactivescript/eval/tasks/desk9/fixtures.mjs";
import { appendFileSync } from "node:fs";
const LOG = process.env.LEGAL_LOG;
const note = (s) => LOG && appendFileSync(LOG, s + "\n");
export default [
  { name: "L1 two issues assigned at once: declined row reverts once the other lands", async run(app) {
    await selected(app);
    await app.type("user", "ann");
    await app.click("assign");
    await app.clickText("issue", "#1 "); await app.land("fetchIssue:1", D1);
    await app.click("assign");
    await app.fail("assign:3,ann", "declined");
    note(`L1 held frame: list=${JSON.stringify(await app.text("list"))} detail=${JSON.stringify(await app.text("detail"))}`);
    await app.land("assign:1,ann", { id: 1, assignee: "ann" });
    await app.landIfAsked("fetchIssues:open", OPEN.map(i => i.id === 1 ? { ...i, assignee: "ann" } : i));
    await app.see("list", "#3 Crash on save (unassigned)", "#1 Login fails (ann)");
  } },
  { name: "L2 a detail that reloads while a rename is out shows the new title once the rename lands", async run(app) {
    await selected(app);
    await rename(app, "Crash at boot");
    await app.click("retry");
    await app.land("fetchIssue:3", D3);
    note(`L2 held frame: detail=${JSON.stringify(await app.text("detail"))}`);
    await app.land("renameIssue:3,Crash at boot", { id: 3, title: "Crash at boot" });
    await app.landIfAsked("fetchIssue:3", { ...D3, title: "Crash at boot" });
    await app.see("detail", "#3 Crash at boot");
  } },
];
