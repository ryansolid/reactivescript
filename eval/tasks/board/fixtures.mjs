// The board's starting data and the moves the tests share.
export const TODO = [{ id: 1, title: "Write spec", done: 0, total: 2 }, { id: 2, title: "Fix login", done: 1, total: 3 }];
export const DOING = [{ id: 3, title: "Review PR", done: 2, total: 2 }, { id: 4, title: "Deploy", done: 0, total: 1 }];
export const DONE = [{ id: 5, title: "Kickoff", done: 3, total: 3 }];
export const card = c => `#${c.id} ${c.title} · ${c.done}/${c.total}`;
export const TODO_ROWS = TODO.map(card), DOING_ROWS = DOING.map(card), DONE_ROWS = DONE.map(card);
/** a third card in Doing, for the work-in-progress limit */
export const DOING3 = [...DOING, { id: 6, title: "Write docs", done: 0, total: 0 }];

/** the three columns loaded */
export async function loaded(app, todo = TODO, doing = DOING, done = DONE) {
  await app.land("fetchCards:todo", todo);
  await app.land("fetchCards:doing", doing);
  await app.land("fetchCards:done", done);
}
/** click a move button (left, right, up, down) beside card `id` */
export async function move(app, id, dir) { await app.clickNear("card", `#${id} `, dir); }

// The checklist of card 2 ("Fix login", 1/3)
export const L2 = [{ id: 21, text: "repro", done: true }, { id: 22, text: "patch", done: false }, { id: 23, text: "test", done: false }];
export const L2_ROWS = ["[x] repro", "[ ] patch", "[ ] test"];
/** the board loaded and card `id` selected */
export async function selected(app, id = 2) { await loaded(app); await app.clickText("card", `#${id} `); }
/** the board loaded, card 2 selected and its checklist loaded */
export async function withChecklist(app) { await selected(app, 2); await app.land("fetchChecklist:2", L2); }
/** click the toggle beside the item whose text is `text` */
export async function toggle(app, text) { await app.clickNear("item", (await app.nearCount("item", `[x] ${text}`, "toggle")) ? `[x] ${text}` : `[ ] ${text}`, "toggle"); }
/** type a title into title-input and click rename */
export async function rename(app, title) { await app.type("title-input", title); await app.click("rename"); }
/** type a title into new-card and click add-card */
export async function addCard(app, title) { await app.type("new-card", title); await app.click("add-card"); }
/** type text into item-input and click add-item */
export async function addItem(app, text) { await app.type("item-input", text); await app.click("add-item"); }

// The archive
export const ARCHIVED = [{ id: 8, title: "Old idea" }, { id: 9, title: "Spike" }];
export const ARCHIVED_ROWS = ["#8 Old idea", "#9 Spike"];
/** open the archive tab and land its list */
export async function archive(app, list = ARCHIVED) { await app.click("tab-archive"); await app.land("fetchArchived:", list); }
