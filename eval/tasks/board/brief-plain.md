# Sprint board

Build a sprint board: two pages behind a row of tabs. The board page shows three columns of cards that can be moved,
reordered, renamed, added and archived, with a detail panel holding the selected card's checklist. The archive page lists
archived cards and can restore them.

This is production code: it ships to real users on real networks. Build it the way you would for that.

## The API (`src/api.js`, given; do not change it)

Cards:

- `fetchCards(column: "todo" | "doing" | "done"): Promise<{ id: number; title: string; done: number; total: number }[]>`:
  the column's cards, top first. `done` and `total` count the card's checklist items. May reject with an `Error`.
- `moveCard(id: number, column: "todo" | "doing" | "done", index: number): Promise<{ id: number; column: string; index: number }>`:
  moves the card on the server to position `index` (0 = top) of `column`, which may be its own column. May reject with an
  `Error` (the server declined).
- `renameCard(id: number, title: string): Promise<{ id: number; title: string }>`. May reject with an `Error`.
- `addCard(column: "todo" | "doing" | "done", title: string): Promise<{ id: number; title: string }>`: adds a card at the
  bottom of the column on the server and answers it with its new id. May reject with an `Error`.
- `archiveCard(id: number): Promise<{ id: number }>`: takes the card off the board on the server and into the archive.
  May reject with an `Error`.

Checklist:

- `fetchChecklist(id: number): Promise<{ id: number; text: string; done: boolean }[]>`: the card's items, in order. May
  reject with an `Error`.
- `toggleItem(cardId: number, itemId: number, done: boolean): Promise<{ id: number; done: boolean }>`. May reject with an
  `Error`.
- `addItem(cardId: number, text: string): Promise<{ id: number; text: string; done: boolean }>`: adds an item at the end
  on the server. May reject with an `Error`.

Archive:

- `fetchArchived(): Promise<{ id: number; title: string }[]>`: archived cards, most recently archived first. May reject
  with an `Error`.
- `restoreCard(id: number): Promise<{ id: number }>`: puts the card back at the bottom of `todo` on the server. May
  reject with an `Error`.

## What the app must do

Elements the tests look for carry these `data-testid`s. Text in quotes must appear exactly as written.

### Tabs

1. Two buttons, `tab-board` and `tab-archive`, always on screen. The app opens on the board page.
2. Only the open page is on screen. Leaving a page discards it: opening it again starts it as it starts when the app
   opens (it loads again, nothing selected, inputs at their starting values).

### The board page

1. **Columns.** Three elements, `col-todo`, `col-doing` and `col-done`, left to right, each from
   `fetchCards(column)`, asked when the page opens.
   - Each column's heading, `head-<column>`, reads `To do (<n>)`, `Doing (<n>)`, `Done (<n>)`, where `<n>` is the number
     of cards the column shows. While the column loads, or if it failed, it reads `To do`, `Doing`, `Done`.
   - While a column loads: `loading`. If it fails: `error: <message>` and a button `retry-<column>` that asks
     `fetchCards(column)` again.
   - Then one element per card, top first, `data-testid="card"`, reading `#<id> <title> · <done>/<total>`
     (`#7 Fix login · 1/3`).
2. **Moving.** Each card has four buttons next to its `card` element: `left`, `right`, `up`, `down`. `left`/`right` move
   the card to the bottom of the next column over; `up`/`down` swap it with the card above or below. A button that has
   nowhere to go (`left` in To do, `up` on the top card) is not shown. Clicking one:
   - moves the card there straight away (both columns' cards and headings follow);
   - calls `moveCard(id, column, index)` with the card's new column and position as shown;
   - if the server declines, the card goes back where it was, and the page shows `move error: <message>` in an element
     `move-error`;
   - if the server accepts, the card stays where it was moved.
   - A move error is cleared when the next move starts.
3. **Work-in-progress limit.** Doing holds at most 3 cards. While Doing shows 3 cards (counting cards moved there that
   the server hasn't answered yet), the `right` button of every To do card is disabled, and the `left` button of every
   Done card too.
4. **Adding.** Under To do, a text input `new-card` and a button `add-card`. Clicking `add-card` while `new-card` holds a
   title:
   - adds the card at the bottom of To do straight away, reading `<title> (adding…)` with no id and no move buttons, and
     empties the input;
   - calls `addCard("todo", title)`;
   - if the server declines, the card goes away and `add-error` shows `add error: <message>`;
   - if the server accepts, the card reads `#<id> <title> · 0/0` and gets its move buttons.
   - An add error is cleared when the next add starts.

### The detail

1. **Selecting.** Clicking a `card` selects it. The detail, `detail`, shows `select a card` while nothing is selected.
2. While a card is selected, the detail shows `#<id> <title>` and `in <column name>` (`in Doing`), where it is on the
   board as shown, moves included.
3. **Rename.** A text input `title-input`, empty when the card is selected, and a button `rename`. Clicking `rename`
   while `title-input` holds a title:
   - shows the new title on the card and in the detail straight away;
   - calls `renameCard(id, title)`;
   - if the server declines, both go back, and the detail shows `rename error: <message>`;
   - if the server accepts, both keep the new title.
4. **Archive.** A button `archive`. Clicking it takes the card off the board straight away and clears the selection
   (`select a card`), then calls `archiveCard(id)`. If the server declines, the card comes back where it was (still not
   selected), and the board shows `archive error: <message>` in `archive-error`. If it accepts, the card stays off.
5. **Checklist**, `checklist`, from `fetchChecklist(id)`.
   - While it loads: `loading checklist`. If it fails: `checklist error: <message>`.
   - Then one row per item, `data-testid="item"`, reading `[x] <text>` when done and `[ ] <text>` when not, each with a
     button `toggle` next to it.
   - A line `progress` reading `<done>/<total> done`.
6. **Toggling.** Clicking an item's `toggle` flips it straight away. The item, `progress`, and the card's
   `<done>/<total>` on the board all follow at once. Then it calls `toggleItem(cardId, itemId, done)`. If the server
   declines, all three go back and the detail shows `item error: <message>`. If it accepts, they stay.
7. **Adding an item.** A text input `item-input` and a button `add-item`. Clicking `add-item` while `item-input` holds
   text: the item shows as the last row straight away, `[ ] <text> (adding…)`, `progress` and the card's total count it,
   and the input empties; then `addItem(cardId, text)`. Declined: it goes away, everything goes back, and the detail shows
   `item error: <message>`. Accepted: it reads `[ ] <text>` and gets its `toggle`.
8. A rename error or an item error is cleared when a new action of its kind starts or another card is selected.

### The archive page

1. A list, `archived`, from `fetchArchived()`: `loading archive` while it loads, `archive error: <message>` if it fails,
   then one row per card, `data-testid="archived-card"`, reading `#<id> <title>`, each with a button `restore`.
2. **Restoring.** Clicking `restore` takes the row off the list straight away and calls `restoreCard(id)`. If the server
   declines, the row comes back where it was and the page shows `restore error: <message>`. If it accepts, the row stays
   off. (The board shows the card when the board page opens again, since it loads again.)
