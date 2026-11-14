// Hidden overlap tests: never shown to the agent. Writes that overlap each other, loads and page lifetimes. Where the
// brief leaves an app free to ask again (a reload after a write), the test answers it if asked (landIfAsked) and
// checks the screen either way.
import { ARCHIVED, ARCHIVED_ROWS, DOING, DOING3, DOING_ROWS, DONE, DONE_ROWS, L2, L2_ROWS, TODO, TODO_ROWS, addCard, addItem, archive, card, loaded, move, rename, selected, toggle, withChecklist } from "./fixtures.mjs";

const [W, F] = [card(TODO[0]), card(TODO[1])];
const [R, D] = [card(DOING[0]), card(DOING[1])];
const K = card(DONE[0]);
const c = (id, title, done, total) => ({ id, title, done, total });
/** answer any column reloads the app asked, with the given server state */
async function reloads(app, todo, doing, done) {
  if (todo) await app.landIfAsked("fetchCards:todo", todo);
  if (doing) await app.landIfAsked("fetchCards:doing", doing);
  if (done) await app.landIfAsked("fetchCards:done", done);
}

export default [
  // one card moved twice
  { name: "two moves of one card answered in order leave it where the second put it", async run(app) {
    await loaded(app);
    await move(app, 1, "down");
    await move(app, 1, "up");
    await app.colRows("todo", TODO_ROWS);
    await app.inAir("moveCard:1,todo,1"); await app.inAir("moveCard:1,todo,0");
    await app.land("moveCard:1,todo,1", { id: 1, column: "todo", index: 1 });
    await app.colRows("todo", TODO_ROWS);
    await app.land("moveCard:1,todo,0", { id: 1, column: "todo", index: 0 });
    await reloads(app, TODO);
    await app.colRows("todo", TODO_ROWS);
  } },
  { name: "a card moved right twice ends in Done", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await move(app, 2, "right");
    await app.colRows("done", [K, F]); await app.colRows("doing", DOING_ROWS);
    await app.inAir("moveCard:2,doing,2"); await app.inAir("moveCard:2,done,1");
    await app.land("moveCard:2,doing,2", { id: 2, column: "doing", index: 2 });
    await app.colRows("done", [K, F]); await app.colRows("doing", DOING_ROWS);
    await app.land("moveCard:2,done,1", { id: 2, column: "done", index: 1 });
    await reloads(app, [TODO[0]], DOING, [...DONE, TODO[1]]);
    await app.colRows("todo", [W]); await app.colRows("doing", DOING_ROWS); await app.colRows("done", [K, F]);
  } },
  { name: "an earlier move declined while a later move of the card is out leaves it where the later one put it", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await move(app, 2, "right");
    await app.fail("moveCard:2,doing,2", "nope");
    await app.colRows("done", [K, F]); await app.colRows("doing", DOING_ROWS); await app.colRows("todo", [W]);
    await app.land("moveCard:2,done,1", { id: 2, column: "done", index: 1 });
    await reloads(app, [TODO[0]], DOING, [...DONE, TODO[1]]);
    await app.colRows("done", [K, F]); await app.colRows("todo", [W]);
  } },
  { name: "a later move declined after an earlier one was accepted puts the card where the earlier one put it", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await move(app, 2, "right");
    await app.land("moveCard:2,doing,2", { id: 2, column: "doing", index: 2 });
    await app.fail("moveCard:2,done,1", "frozen");
    await reloads(app, [TODO[0]], [...DOING, TODO[1]], DONE);
    await app.colRows("doing", [R, D, F]); await app.colRows("done", DONE_ROWS); await app.colRows("todo", [W]);
    await app.see("move-error", "move error: frozen");
  } },

  // two cards
  { name: "one of two moves declined puts back only its card", async run(app) {
    await loaded(app);
    await move(app, 3, "right");
    await move(app, 4, "right");
    await app.colRows("done", [K, R, D]); await app.colRows("doing", []);
    await app.fail("moveCard:3,done,1", "nope");
    await app.colRows("doing", [R]); await app.colRows("done", [K, D]);
    await app.eq("head-doing", "Doing (1)"); await app.eq("head-done", "Done (2)");
  } },
  { name: "a move into To do while a card is being added there keeps both", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await move(app, 3, "left");
    await app.eq("head-todo", "To do (4)");
    await app.land("addCard:todo,Plan sprint", { id: 7, title: "Plan sprint" });
    await app.landOnly("moveCard", { id: 3, column: "todo", index: 3 });
    await reloads(app, [...TODO, c(7, "Plan sprint", 0, 0), DOING[0]], [DOING[1]]);
    const shown = (await app.items("card")).filter(t => t.startsWith("#7 ") || t.startsWith("#3 "));
    if (shown.length !== 2) throw new Error(`expected #7 and #3 once each, shown: ${JSON.stringify(shown)}`);
    await app.eq("head-todo", "To do (4)");
  } },

  // loads and reloads
  { name: "a column that reloads while a move into it is out keeps the moved card", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await move(app, 3, "down");
    await app.land("moveCard:3,doing,1", { id: 3, column: "doing", index: 1 });
    await reloads(app, TODO, [DOING[1], DOING[0]]);              // the server hasn't moved #2 yet
    await app.colRows("doing", [D, R, F]); await app.colRows("todo", [W]);
    await app.land("moveCard:2,doing,2", { id: 2, column: "doing", index: 2 });
    await reloads(app, [TODO[0]], [DOING[1], DOING[0], TODO[1]]);
    await app.colRows("doing", [D, R, F]); await app.colRows("todo", [W]);
  } },
  { name: "a move into a column that is still loading shows once it loads, or waits for it", async run(app) {
    await app.land("fetchCards:todo", TODO);
    await app.land("fetchCards:done", DONE);
    const btn = app.near("card", "#2 ", "right");
    if ((await btn.count()) && !(await btn.first().isDisabled())) {
      await move(app, 2, "right");
      await app.land("fetchCards:doing", DOING);
      await app.colRows("doing", [R, D, F]); await app.colRows("todo", [W]);
      await app.eq("head-doing", "Doing (3)");
    } else {
      await app.land("fetchCards:doing", DOING);
      await app.nearDisabled("card", "#2 ", "right", false);
    }
  } },
  { name: "an add accepted while To do reloads shows the card once", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await move(app, 1, "down");
    await app.land("moveCard:1,todo,1", { id: 1, column: "todo", index: 1 });
    await reloads(app, [TODO[1], TODO[0]]);                      // the server hasn't added it yet
    await app.land("addCard:todo,Plan sprint", { id: 7, title: "Plan sprint" });
    await reloads(app, [TODO[1], TODO[0], c(7, "Plan sprint", 0, 0)]);
    await app.colRows("todo", [F, W, "#7 Plan sprint · 0/0"]);
  } },
  { name: "toggles keep showing while the checklist reloads", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await toggle(app, "test");
    await app.land("toggleItem:2,23,true", { id: 23, done: true });
    await app.landIfAsked("fetchChecklist:2", [L2[0], L2[1], { ...L2[2], done: true }]);   // the server hasn't taken the first yet
    await reloads(app, [TODO[0], { ...TODO[1], done: 2 }]);
    await app.rows("item", ["[x] repro", "[x] patch", "[x] test"]);
    await app.eq("progress", "3/3 done");
    await app.colRows("todo", [W, "#2 Fix login · 3/3"]);
  } },
  { name: "an item added while the checklist reloads shows once", async run(app) {
    await withChecklist(app);
    await addItem(app, "ship");
    await toggle(app, "patch");
    await app.land("toggleItem:2,22,true", { id: 22, done: true });
    await app.landIfAsked("fetchChecklist:2", [L2[0], { ...L2[1], done: true }, L2[2]]);
    await app.land("addItem:2,ship", { id: 24, text: "ship", done: false });
    await app.landIfAsked("fetchChecklist:2", [L2[0], { ...L2[1], done: true }, L2[2], { id: 24, text: "ship", done: false }]);
    await reloads(app, [TODO[0], { ...TODO[1], done: 2, total: 4 }]);
    await app.rows("item", ["[x] repro", "[x] patch", "[ ] test", "[ ] ship"]);
    await app.eq("progress", "2/4 done");
    await app.colRows("todo", [W, "#2 Fix login · 2/4"]);
  } },

  // counts that must agree
  { name: "a toggle and an item add out together: the progress and the card's count agree", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await addItem(app, "ship");
    await app.eq("progress", "2/4 done");
    await app.colRows("todo", [W, "#2 Fix login · 2/4"]);
    await app.fail("toggleItem:2,22,true", "read only");
    await app.eq("progress", "1/4 done");
    await app.colRows("todo", [W, "#2 Fix login · 1/4"]);
  } },
  { name: "a toggle accepted after another card was selected keeps the first card's count", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await app.clickText("card", "#1 ");
    await app.land("toggleItem:2,22,true", { id: 22, done: true });
    await reloads(app, [TODO[0], { ...TODO[1], done: 2 }]);
    await app.colRows("todo", [W, "#2 Fix login · 2/3"]);
  } },
  { name: "a toggle declined after another card was selected puts the first card's count back", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await app.clickText("card", "#1 ");
    await app.fail("toggleItem:2,22,true", "read only");
    await app.colRows("todo", TODO_ROWS);
  } },

  // renames and archives
  { name: "a rename and a move out together, the move declined: the card goes back with its new title", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await move(app, 2, "right");
    await app.fail("moveCard:2,doing,2", "nope");
    await app.colRows("todo", [W, "#2 Fix signup · 1/3"]);
    await app.see("detail", "#2 Fix signup", "in To do");
  } },
  { name: "two renames, the later declined after the earlier was accepted: the earlier title stays", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await rename(app, "Fix auth");
    await app.see("detail", "#2 Fix auth");
    await app.land("renameCard:2,Fix signup", { id: 2, title: "Fix signup" });
    await app.fail("renameCard:2,Fix auth", "taken");
    await reloads(app, [TODO[0], { ...TODO[1], title: "Fix signup" }]);
    await app.colRows("todo", [W, "#2 Fix signup · 1/3"]);
    await app.see("detail", "#2 Fix signup", "rename error: taken");
  } },
  { name: "archiving a card whose rename is out keeps it off the board when the rename lands", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await app.click("archive");
    await app.see("detail", "select a card");
    await app.land("renameCard:2,Fix signup", { id: 2, title: "Fix signup" });
    await reloads(app, [TODO[0]]);
    await app.colRows("todo", [W]);
    await app.see("detail", "select a card");
    await app.land("archiveCard:2", { id: 2 });
    await reloads(app, [TODO[0]]);
    await app.colRows("todo", [W]);
  } },
  { name: "a declined archive of a card whose rename is out brings it back with the new title", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await app.click("archive");
    await app.fail("archiveCard:2", "in use");
    await app.colRows("todo", [W, "#2 Fix signup · 1/3"]);
    await app.land("renameCard:2,Fix signup", { id: 2, title: "Fix signup" });
    await reloads(app, [TODO[0], { ...TODO[1], title: "Fix signup" }]);
    await app.colRows("todo", [W, "#2 Fix signup · 1/3"]);
  } },

  // the work-in-progress limit
  { name: "a declined move out of a full Doing disables To do's right again", async run(app) {
    await loaded(app, TODO, DOING3);
    await move(app, 6, "right");
    await app.nearDisabled("card", "#1 ", "right", false);
    await app.fail("moveCard:6,done,1", "nope");
    await app.nearDisabled("card", "#1 ", "right");
  } },
  { name: "a move into Doing that fills it while a move out is pending disables the rest", async run(app) {
    await loaded(app, TODO, DOING3);
    await move(app, 6, "right");
    await move(app, 2, "right");
    await app.nearDisabled("card", "#1 ", "right");
    await app.fail("moveCard:6,done,1", "nope");
    const doing = (await app.items("card")).filter(t => ["#3 ", "#4 ", "#6 ", "#2 "].some(p => t.startsWith(p)));   // #6 back and #2 in, in either order
    if (doing.length !== 4) throw new Error(`expected #3, #4, #6 and #2 in Doing, shown: ${JSON.stringify(doing)}`);
    await app.eq("head-doing", "Doing (4)");
    await app.nearDisabled("card", "#1 ", "right");
  } },

  // page lifetime
  { name: "a move accepted after the board was left shows nothing extra on the next visit", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await app.click("tab-archive");
    await app.land("moveCard:2,doing,2", { id: 2, column: "doing", index: 2 });
    await app.click("tab-board");
    await loaded(app, [TODO[0]], [...DOING, TODO[1]], DONE);
    await app.colRows("todo", [W]); await app.colRows("doing", [R, D, F]);
  } },
  { name: "a move declined after the board was left shows no move error on the next visit", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await app.click("tab-archive");
    await app.click("tab-board");
    await app.fail("moveCard:2,doing,2", "nope");
    await loaded(app);
    await app.colRows("todo", TODO_ROWS); await app.colRows("doing", DOING_ROWS);
    await app.notSeePage("move error");
  } },
  { name: "an add accepted after the board was left does not show twice on the next visit", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await app.click("tab-archive");
    await app.click("tab-board");
    await app.land("addCard:todo,Plan sprint", { id: 7, title: "Plan sprint" });
    await loaded(app, [...TODO, c(7, "Plan sprint", 0, 0)]);
    await app.colRows("todo", [...TODO_ROWS, "#7 Plan sprint · 0/0"]);
  } },
  { name: "an archive declined after the board was left shows no archive error on the next visit", async run(app) {
    await selected(app, 2);
    await app.click("archive");
    await app.click("tab-archive");
    await app.click("tab-board");
    await app.fail("archiveCard:2", "in use");
    await loaded(app);
    await app.colRows("todo", TODO_ROWS);
    await app.notSeePage("archive error");
  } },
  { name: "a restore declined after the archive was left shows no restore error on the next visit", async run(app) {
    await archive(app);
    await app.clickNear("archived-card", "#8 ", "restore");
    await app.click("tab-board");
    await app.click("tab-archive");
    await app.fail("restoreCard:8", "no room");
    await app.land("fetchArchived:", ARCHIVED);
    await app.rows("archived-card", ARCHIVED_ROWS);
    await app.notSeePage("restore error");
  } },
  { name: "a restore declined after another was accepted brings back only its row", async run(app) {
    await archive(app);
    await app.clickNear("archived-card", "#8 ", "restore");
    await app.clickNear("archived-card", "#9 ", "restore");
    await app.land("restoreCard:8", { id: 8 });
    await app.fail("restoreCard:9", "no room");
    await app.landIfAsked("fetchArchived:", [ARCHIVED[1]]);
    await app.rows("archived-card", ["#9 Spike"]);
  } },
];
