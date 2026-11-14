// Hidden tests: never shown to the agent. Each follows a line of the brief; none names a race the brief doesn't imply.
import { ARCHIVED, ARCHIVED_ROWS, DOING, DOING3, DOING_ROWS, DONE, DONE_ROWS, L2, L2_ROWS, TODO, TODO_ROWS, addCard, addItem, archive, card, loaded, move, rename, selected, toggle, withChecklist } from "./fixtures.mjs";

const [W, F] = [card(TODO[0]), card(TODO[1])];          // "#1 Write spec · 0/2", "#2 Fix login · 1/3"
const [R, D] = [card(DOING[0]), card(DOING[1])];        // "#3 Review PR · 2/2", "#4 Deploy · 0/1"
const K = card(DONE[0]);                                // "#5 Kickoff · 3/3"

export default [
  // tabs
  { name: "the app opens on the board page with both tabs on screen", async run(app) {
    if (!(await app.exists("tab-board")) || !(await app.exists("tab-archive"))) throw new Error("both tabs should be on screen");
    if (await app.exists("archived")) throw new Error("the archive page is on screen");
    await app.inAir("fetchCards:todo"); await app.inAir("fetchCards:doing"); await app.inAir("fetchCards:done");
  } },
  { name: "the archive page loads again each time it opens", async run(app) {
    await archive(app);
    await app.click("tab-board");
    await app.click("tab-archive");
    await app.see("archived", "loading archive");
    await app.land("fetchArchived:", ARCHIVED);
    await app.rows("archived-card", ARCHIVED_ROWS);
  } },
  { name: "the new-card input starts empty when the board opens again", async run(app) {
    await loaded(app);
    await app.type("new-card", "half typed");
    await app.click("tab-archive");
    await app.click("tab-board");
    await app.hasValue("new-card", "");
  } },
  { name: "an archive that fails shows its error", async run(app) {
    await app.click("tab-archive");
    await app.fail("fetchArchived:", "offline");
    await app.see("archived", "archive error: offline");
  } },

  // columns
  { name: "a heading counts only once its column has loaded", async run(app) {
    await app.land("fetchCards:doing", DOING);
    await app.eq("head-doing", "Doing (2)");
    await app.eq("head-todo", "To do");
    await app.see("col-todo", "loading");
  } },
  { name: "a column's retry shows loading, then the cards", async run(app) {
    await app.fail("fetchCards:done", "offline");
    await app.click("retry-done");
    await app.see("col-done", "loading");
    await app.eq("head-done", "Done");
    await app.land("fetchCards:done", DONE);
    await app.colRows("done", DONE_ROWS);
    await app.eq("head-done", "Done (1)");
  } },
  { name: "an empty column reads (0)", async run(app) {
    await loaded(app, TODO, DOING, []);
    await app.eq("head-done", "Done (0)");
    await app.colRows("done", []);
  } },

  // moving
  { name: "left moves a Doing card to the bottom of To do", async run(app) {
    await loaded(app);
    await move(app, 3, "left");
    await app.colRows("todo", [W, F, R]); await app.colRows("doing", [D]);
    await app.inAir("moveCard:3,todo,2");
  } },
  { name: "right moves a Doing card to the bottom of Done", async run(app) {
    await loaded(app);
    await move(app, 4, "right");
    await app.colRows("done", [K, D]);
    await app.inAir("moveCard:4,done,1");
  } },
  { name: "down swaps a card with the one below it", async run(app) {
    await loaded(app);
    await move(app, 3, "down");
    await app.colRows("doing", [D, R]);
    await app.inAir("moveCard:3,doing,1");
  } },
  { name: "a declined reorder puts the cards back in their order", async run(app) {
    await loaded(app);
    await move(app, 1, "down");
    await app.fail("moveCard:1,todo,1", "nope");
    await app.colRows("todo", TODO_ROWS);
    await app.see("move-error", "move error: nope");
  } },
  { name: "a declined move from Done puts the card back in Done", async run(app) {
    await loaded(app);
    await move(app, 5, "left");
    await app.colRows("doing", [R, D, K]);
    await app.fail("moveCard:5,doing,2", "frozen");
    await app.colRows("done", DONE_ROWS); await app.colRows("doing", DOING_ROWS);
    await app.eq("head-done", "Done (1)"); await app.eq("head-doing", "Doing (2)");
  } },
  { name: "a moved card's buttons follow its new place", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    if (!(await app.nearCount("card", "#2 ", "left")) || !(await app.nearCount("card", "#2 ", "up"))) throw new Error("#2 in Doing should have left and up");
    await app.noNear("card", "#2 ", "down");
    await app.noNear("card", "#1 ", "down");
  } },
  { name: "the move error is cleared when the next move starts", async run(app) {
    await loaded(app);
    await move(app, 1, "down");
    await app.fail("moveCard:1,todo,1", "nope");
    await app.see("move-error", "move error: nope");
    await move(app, 3, "down");
    await app.notSee("move-error", "nope");
  } },
  { name: "a move error stays when another move is accepted", async run(app) {
    await loaded(app);
    await move(app, 1, "down");
    await move(app, 3, "down");
    await app.fail("moveCard:1,todo,1", "nope");
    await app.land("moveCard:3,doing,1", { id: 3, column: "doing", index: 1 });
    await app.see("move-error", "move error: nope");
    await app.colRows("todo", TODO_ROWS); await app.colRows("doing", [D, R]);
  } },

  // the work-in-progress limit
  { name: "a move into Doing that brings it to three disables To do's right at once", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await app.nearDisabled("card", "#1 ", "right");
    await app.nearDisabled("card", "#5 ", "left");
  } },
  { name: "a declined move into Doing enables the right buttons again", async run(app) {
    await loaded(app);
    await move(app, 2, "right");
    await app.fail("moveCard:2,doing,2", "nope");
    await app.nearDisabled("card", "#1 ", "right", false);
    await app.nearDisabled("card", "#2 ", "right", false);
  } },
  { name: "a move out of a full Doing enables the right buttons at once", async run(app) {
    await loaded(app, TODO, DOING3);
    await move(app, 6, "right");
    await app.nearDisabled("card", "#1 ", "right", false);
    await app.nearDisabled("card", "#5 ", "left", false);
  } },
  { name: "Doing's own buttons are not limited", async run(app) {
    await loaded(app, TODO, DOING3);
    await app.nearDisabled("card", "#3 ", "down", false);
    await app.nearDisabled("card", "#4 ", "left", false);
  } },

  // adding
  { name: "add-card with an empty input adds nothing", async run(app) {
    await loaded(app);
    await app.click("add-card");
    await app.colRows("todo", TODO_ROWS);
    await app.noneInAir("addCard");
  } },
  { name: "a card being added counts in the heading", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await app.eq("head-todo", "To do (3)");
    await app.fail("addCard:todo,Plan sprint", "no");
    await app.eq("head-todo", "To do (2)");
  } },
  { name: "the add error is cleared when the next add starts", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await app.fail("addCard:todo,Plan sprint", "too many cards");
    await addCard(app, "Retro");
    await app.notSeePage("add error: too many cards");
  } },
  { name: "two adds show both, each taking its own id", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await addCard(app, "Retro");
    await app.colRows("todo", [...TODO_ROWS, "Plan sprint (adding…)", "Retro (adding…)"]);
    await app.land("addCard:todo,Retro", { id: 8, title: "Retro" });
    await app.colRows("todo", [...TODO_ROWS, "Plan sprint (adding…)", "#8 Retro · 0/0"]);
    await app.land("addCard:todo,Plan sprint", { id: 7, title: "Plan sprint" });
    await app.colRows("todo", [...TODO_ROWS, "#7 Plan sprint · 0/0", "#8 Retro · 0/0"]);
  } },
  { name: "a card being added has no move buttons", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    for (const b of ["left", "right", "up", "down"]) await app.noNear("card", "Plan sprint", b);
  } },
  { name: "an added card can be moved once it has its id", async run(app) {
    await loaded(app);
    await addCard(app, "Plan sprint");
    await app.land("addCard:todo,Plan sprint", { id: 7, title: "Plan sprint" });
    await move(app, 7, "up");
    await app.colRows("todo", [W, "#7 Plan sprint · 0/0", F]);
    await app.inAir("moveCard:7,todo,1");
  } },

  // the detail
  { name: "the detail names the column of a card in Done", async run(app) {
    await selected(app, 5);
    await app.see("detail", "#5 Kickoff", "in Done");
  } },
  { name: "a declined move puts the detail's column back", async run(app) {
    await selected(app, 2);
    await move(app, 2, "right");
    await app.fail("moveCard:2,doing,2", "nope");
    await app.see("detail", "in To do");
  } },
  { name: "selecting another card shows its detail and empties title-input", async run(app) {
    await selected(app, 2);
    await app.type("title-input", "half typed");
    await app.clickText("card", "#3 ");
    await app.see("detail", "#3 Review PR", "in Doing");
    await app.hasValue("title-input", "");
  } },
  { name: "rename with an empty title-input asks nothing", async run(app) {
    await selected(app, 2);
    await app.click("rename");
    await app.noneInAir("renameCard");
  } },
  { name: "the rename error is cleared when another card is selected", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await app.fail("renameCard:2,Fix signup", "taken");
    await app.clickText("card", "#3 ");
    await app.notSee("detail", "rename error");
  } },
  { name: "the rename error is cleared when the next rename starts", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await app.fail("renameCard:2,Fix signup", "taken");
    await rename(app, "Fix auth");
    await app.notSee("detail", "rename error: taken");
  } },
  { name: "a renamed card keeps its new title when it moves", async run(app) {
    await selected(app, 2);
    await rename(app, "Fix signup");
    await move(app, 2, "right");
    await app.colRows("doing", [R, D, "#2 Fix signup · 1/3"]);
    await app.land("renameCard:2,Fix signup", { id: 2, title: "Fix signup" });
    await app.land("moveCard:2,doing,2", { id: 2, column: "doing", index: 2 });
    await app.colRows("doing", [R, D, "#2 Fix signup · 1/3"]);
  } },
  { name: "archiving a card counts it out of its heading at once", async run(app) {
    await selected(app, 3);
    await app.click("archive");
    await app.eq("head-doing", "Doing (1)");
  } },
  { name: "a declined archive brings the card back in its place", async run(app) {
    await selected(app, 3);
    await app.click("archive");
    await app.fail("archiveCard:3", "in use");
    await app.colRows("doing", DOING_ROWS);
    await app.eq("head-doing", "Doing (2)");
  } },
  { name: "archiving a card from a full Doing enables To do's right at once", async run(app) {
    await loaded(app, TODO, DOING3);
    await app.clickText("card", "#6 ");
    await app.click("archive");
    await app.nearDisabled("card", "#1 ", "right", false);
  } },

  // the checklist
  { name: "an empty checklist reads 0/0 done", async run(app) {
    await selected(app, 5);
    await app.land("fetchChecklist:5", []);
    await app.rows("item", []);
    await app.eq("progress", "0/0 done");
  } },
  { name: "toggling a done item un-does it", async run(app) {
    await withChecklist(app);
    await toggle(app, "repro");
    await app.rows("item", ["[ ] repro", "[ ] patch", "[ ] test"]);
    await app.eq("progress", "0/3 done");
    await app.colRows("todo", [W, "#2 Fix login · 0/3"]);
    await app.inAir("toggleItem:2,21,false");
  } },
  { name: "an accepted toggle keeps the item, the progress and the card's count", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await app.land("toggleItem:2,22,true", { id: 22, done: true });
    await app.rows("item", ["[x] repro", "[x] patch", "[ ] test"]);
    await app.eq("progress", "2/3 done");
    await app.colRows("todo", [W, "#2 Fix login · 2/3"]);
  } },
  { name: "selecting another card loads its checklist", async run(app) {
    await withChecklist(app);
    await app.clickText("card", "#1 ");
    await app.see("checklist", "loading checklist");
    await app.land("fetchChecklist:1", [{ id: 11, text: "outline", done: false }, { id: 12, text: "draft", done: false }]);
    await app.rows("item", ["[ ] outline", "[ ] draft"]);
    await app.eq("progress", "0/2 done");
  } },
  { name: "the item error is cleared when another card is selected", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await app.fail("toggleItem:2,22,true", "read only");
    await app.clickText("card", "#1 ");
    await app.notSee("detail", "item error");
  } },
  { name: "the item error is cleared when the next item action starts", async run(app) {
    await withChecklist(app);
    await toggle(app, "patch");
    await app.fail("toggleItem:2,22,true", "read only");
    await addItem(app, "ship");
    await app.notSee("detail", "item error: read only");
  } },
  { name: "add-item with an empty input adds nothing", async run(app) {
    await withChecklist(app);
    await app.click("add-item");
    await app.rows("item", L2_ROWS);
    await app.noneInAir("addItem");
  } },
  { name: "a declined item add puts the card's count back", async run(app) {
    await withChecklist(app);
    await addItem(app, "ship");
    await app.fail("addItem:2,ship", "full");
    await app.colRows("todo", TODO_ROWS);
  } },
  { name: "an added item can be toggled once it has its id", async run(app) {
    await withChecklist(app);
    await addItem(app, "ship");
    await app.land("addItem:2,ship", { id: 24, text: "ship", done: false });
    await toggle(app, "ship");
    await app.inAir("toggleItem:2,24,true");
    await app.eq("progress", "2/4 done");
    await app.colRows("todo", [W, "#2 Fix login · 2/4"]);
  } },

  // the archive page
  { name: "an accepted restore keeps the row off, and the board shows the card when it opens again", async run(app) {
    await archive(app);
    await app.clickNear("archived-card", "#8 ", "restore");
    await app.land("restoreCard:8", { id: 8 });
    await app.click("tab-board");
    await loaded(app, [...TODO, { id: 8, title: "Old idea", done: 0, total: 0 }]);
    await app.colRows("todo", [...TODO_ROWS, "#8 Old idea · 0/0"]);
  } },
];
