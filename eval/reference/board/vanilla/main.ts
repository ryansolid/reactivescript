// The sprint board: two pages behind a row of tabs. Only the open page exists: leaving a page aborts its signal,
// which discards everything it was waiting for, and opening it again builds it afresh.
import { archivePage } from "./archive";
import { BoardPage } from "./board/page";
import { button, h } from "./dom";

type Page = "board" | "archive";

export default function mount(root: HTMLElement): void {
  let current: AbortController | null = null;
  const tabs: Record<Page, HTMLButtonElement> = {
    board: button("tab-board", "Board", () => open("board")),
    archive: button("tab-archive", "Archive", () => open("archive")),
  };
  const pageEl = h("div");
  root.replaceChildren(h("nav", null, tabs.board, " ", tabs.archive), pageEl);

  function open(page: Page) {
    current?.abort();
    current = new AbortController();
    const signal = current.signal;
    for (const [name, tab] of Object.entries(tabs)) tab.setAttribute("aria-pressed", String(name === page));
    pageEl.replaceChildren(page === "board" ? new BoardPage(signal).root : archivePage(signal));
  }

  open("board");
}
