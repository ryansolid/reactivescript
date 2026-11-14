// Visible tests: the agent sees and runs these.
import { ARCHIVED, ARCHIVED_ROWS, DOING, DOING3, DOING_ROWS, DONE_ROWS, L2, L2_ROWS, TODO, TODO_ROWS, addCard, addItem, archive, card, loaded, move, rename, selected, toggle, withChecklist } from "./fixtures.mjs";

export default [
  // tabs and columns
  { name: "on load: the board page shows three loading columns, then their cards", async run(app) {
    await app.eq("head-todo", "To do"); await app.eq("head-doing", "Doing"); await app.eq("head-done", "Done");
    await app.see("col-todo", "loading"); await app.see("col-doing", "loading"); await app.see("col-done", "loading");
    await app.see("detail", "select a card");
    await loaded(app);
    await app.colRows("todo", TODO_ROWS); await app.colRows("doing", DOING_ROWS); await app.colRows("done", DONE_ROWS);
    await app.eq("head-todo", "To do (2)"); await app.eq("head-doing", "Doing (2)"); await app.eq("head-done", "Done (1)");
  } },
  { name: "a column that fails shows its error, and retry asks again", async run(app) {
    await app.land("fetchCards:todo", TODO);
    await app.fail("fetchCards:doing", "offline");
    await app.see("col-doing", "error: offline");
    await app.eq("head-doing", "Doing");
    await app.click("retry-doing");
    await app.see("col-doing", "loading");
    await app.land("fetchCards:doing", DOING);
    await app.colRows("doing", DOING_ROWS);
  } },
  { name: "the archive tab shows the archive page, and the board tab the board again", async run(app) {
    await loaded(app);
    await archive(app);
    await app.rows("archived-card", ARCHIVED_ROWS);
    if (await app.exists("col-todo")) throw new Error("the board is still on screen");
    await app.click("tab-board");
    await app.see("col-todo", "loading");
  } },

  // moving
  { name: "right moves a card to the bottom of the next column at once", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await app.colRows("todo", [card(TODO[0])]);
    await app.colRows("doing", [...DOING_ROWS, card(TODO[1])]);
    await app.eq("head-todo", "To do (1)"); await app.eq("head-doing", "Doing (3)");
    await app.inAir("moveCard:2,doing,2");
  } },
  { name: "an accepted move keeps the card where it was moved", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await app.land("moveCard:2,doing,2", { id: 2, column: "doing", index: 2 });
    await app.colRows("doing", [...DOING_ROWS, card(TODO[1])]);
  } },
  { name: "a declined move puts the card back and shows the move error", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await app.fail("moveCard:2,doing,2", "column locked");
    await app.colRows("todo", TODO_ROWS); await app.colRows("doing", DOING_ROWS);
    await app.eq("head-doing", "Doing (2)");
    await app.see("move-error", "move error: column locked");
  } },
  { name: "up swaps a card with the one above it", async run(app) {
    await loaded(app);
    await move(app, 2, "up");
    await app.colRows("todo", [card(TODO[1]), card(TODO[0])]);
    await app.inAir("moveCard:2,todo,0");
  } },
  { name: "a move button with nowhere to go is not shown", async run(app) {
    await loaded(app);
    await app.noNear("card", "#1 ", "left"); await app.noNear("card", "#1 ", "up");
    await app.noNear("card", "#2 ", "down");
    await app.noNear("card", "#5 ", "right");
    if (!(await app.nearCount("card", "#1 ", "right")) || !(await app.nearCount("card", "#1 ", "down"))) throw new Error("#1 should have right and down");
  } },
  { name: "with three cards in Doing, To do's right and Done's left are disabled", async run(app) {
    await loaded(app, TODO, DOING3);
    await app.nearDisabled("card", "#1 ", "right"); await app.nearDisabled("card", "#2 ", "right");
    await app.nearDisabled("card", "#5 ", "left");
    await app.nearDisabled("card", "#3 ", "right", false);
  } },

  // adding
  { name: "adding a card shows it at the bottom of To do at once, then its id", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await app.colRows("todo", [...TODO_ROWS, "Plan sprint (adding…)"]);
    await app.hasValue("new-card", "");
    await app.inAir("addCard:todo,Plan sprint");
    await app.land("addCard:todo,Plan sprint", { id: 7, title: "Plan sprint" });
    await app.colRows("todo", [...TODO_ROWS, "#7 Plan sprint · 0/0"]);
    if (!(await app.nearCount("card", "#7 ", "right"))) throw new Error("the added card has no move buttons");
  } },
  { name: "a declined add takes the card away and shows the add error", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await app.fail("addCard:todo,Plan sprint", "too many cards");
    await app.colRows("todo", TODO_ROWS);
    await app.see("add-error", "add error: too many cards");
  } },

  // the detail
  { name: "selecting a card shows it in the detail with its column", async run(app) {
    await selected(app, 2);
    await app.see("detail", "#2 Fix login", "in To do");
    await app.hasValue("title-input", "");
    await app.see("checklist", "loading checklist");
  } },
  { name: "the detail's column follows a move", async run(app) {
    await selected(app, 2);
    await move(app, 2, "right");
    await app.see("detail", "in Doing");
  } },
  { name: "renaming shows the new title on the card and in the detail at once", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await app.colRows("todo", [card(TODO[0]), "#2 Fix signup · 1/3"]);
    await app.see("detail", "#2 Fix signup");
    await app.inAir("renameCard:2,Fix signup");
    await app.land("renameCard:2,Fix signup", { id: 2, title: "Fix signup" });
    await app.see("detail", "#2 Fix signup");
  } },
  { name: "a declined rename puts the title back and shows the rename error", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await app.fail("renameCard:2,Fix signup", "taken");
    await app.colRows("todo", TODO_ROWS);
    await app.see("detail", "#2 Fix login", "rename error: taken");
  } },
  { name: "archiving takes the card off the board and clears the selection", async run(app) {
    await selected(app, 2);
    await app.click("archive");
    await app.colRows("todo", [card(TODO[0])]);
    await app.see("detail", "select a card");
    await app.inAir("archiveCard:2");
    await app.land("archiveCard:2", { id: 2 });
    await app.colRows("todo", [card(TODO[0])]);
  } },
  { name: "a declined archive brings the card back, not selected, with the archive error", async run(app) {
    await selected(app, 2);
    await app.click("archive");
    await app.fail("archiveCard:2", "in use");
    await app.colRows("todo", TODO_ROWS);
    await app.see("detail", "select a card");
    await app.see("archive-error", "archive error: in use");
  } },

  // the checklist
  { name: "the checklist loads with its progress", async run(app) {
    await withChecklist(app);
    await app.rows("item", L2_ROWS);
    await app.eq("progress", "1/3 done");
  } },
  { name: "a checklist that fails shows its error", async run(app) {
    await selected(app, 2);
    await app.fail("fetchChecklist:2", "gone");
    await app.see("checklist", "checklist error: gone");
  } },
  { name: "toggling an item flips it, the progress and the card's count at once", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await app.rows("item", ["[x] repro", "[x] patch", "[ ] test"]);
    await app.eq("progress", "2/3 done");
    await app.colRows("todo", [card(TODO[0]), "#2 Fix login · 2/3"]);
    await app.inAir("toggleItem:2,22,true");
  } },
  { name: "a declined toggle puts all three back and shows the item error", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await app.fail("toggleItem:2,22,true", "read only");
    await app.rows("item", L2_ROWS);
    await app.eq("progress", "1/3 done");
    await app.colRows("todo", TODO_ROWS);
    await app.see("detail", "item error: read only");
  } },
  { name: "adding an item shows it at once, counted, then with its toggle", async run(app) {
    await withChecklist(app);
    await addItem(app, "ship");
    await app.rows("item", [...L2_ROWS, "[ ] ship (adding…)"]);
    await app.eq("progress", "1/4 done");
    await app.colRows("todo", [card(TODO[0]), "#2 Fix login · 1/4"]);
    await app.hasValue("item-input", "");
    await app.land("addItem:2,ship", { id: 24, text: "ship", done: false });
    await app.rows("item", [...L2_ROWS, "[ ] ship"]);
    if (!(await app.nearCount("item", "[ ] ship", "toggle"))) throw new Error("the added item has no toggle");
  } },
  { name: "a declined item add takes it away and shows the item error", async run(app) {
    await withChecklist(app);
    await addItem(app, "ship");
    await app.fail("addItem:2,ship", "full");
    await app.rows("item", L2_ROWS);
    await app.eq("progress", "1/3 done");
    await app.see("detail", "item error: full");
  } },

  // the archive page
  { name: "the archive loads, and restore takes a row off at once", async run(app) {
    await app.click("tab-archive");
    await app.see("archived", "loading archive");
    await app.land("fetchArchived:", ARCHIVED);
    await app.rows("archived-card", ARCHIVED_ROWS);
    await app.clickNear("archived-card", "#8 ", "restore");
    await app.rows("archived-card", ["#9 Spike"]);
    await app.inAir("restoreCard:8");
    await app.land("restoreCard:8", { id: 8 });
    await app.rows("archived-card", ["#9 Spike"]);
  } },
  { name: "a declined restore brings the row back with the restore error", async run(app) {
    await archive(app);
    await app.clickNear("archived-card", "#8 ", "restore");
    await app.fail("restoreCard:8", "no room");
    await app.rows("archived-card", ARCHIVED_ROWS);
    await app.seePage("restore error: no room");
  } },
  { name: "opening the board again loads it again with nothing selected", async run(app) {
    await selected(app, 2);
    await archive(app);
    await app.click("tab-board");
    await app.see("detail", "select a card");
    await loaded(app);
    await app.colRows("todo", TODO_ROWS);
  } },
];
