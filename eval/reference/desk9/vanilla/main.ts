// The issue desk: three pages behind a row of tabs. Only the open page exists: leaving a page aborts its signal,
// which discards everything it was waiting for, and opening it again builds it afresh.
import { button, h } from "./dom";
import { helpPage } from "./help";
import { IssuesPage } from "./issues/page";
import { settingsPage } from "./settings";

type Page = { name: "issues" } | { name: "help"; query: string; selected: number | null } | { name: "settings" };

export default function mount(root: HTMLElement): void {
  let current: AbortController | null = null;
  const issuesTab = button("tab-issues", "Issues", () => open({ name: "issues" }));
  const tabs = {
    issues: issuesTab,
    help: button("tab-help", "Help", () => open({ name: "help", query: "", selected: null })),
    settings: button("tab-settings", "Settings", () => open({ name: "settings" })),
  };
  const pageEl = h("div");
  root.replaceChildren(h("nav", null, tabs.issues, " ", tabs.help, " ", tabs.settings), pageEl);

  // the number of open issues the issues page last showed; it stays while the list is away, and on other pages
  const setOpenCount = (n: number) => {
    issuesTab.textContent = `Issues (${n})`;
  };

  function open(page: Page) {
    current?.abort();
    current = new AbortController();
    const signal = current.signal;
    for (const [name, tab] of Object.entries(tabs)) tab.setAttribute("aria-current", String(name === page.name));
    if (page.name === "issues")
      pageEl.replaceChildren(
        new IssuesPage(signal, {
          onOpenCount: setOpenCount,
          openHelp: (query, selected) => open({ name: "help", query, selected }),
        }).root,
      );
    else if (page.name === "help") pageEl.replaceChildren(helpPage(signal, page));
    else pageEl.replaceChildren(settingsPage(signal));
  }

  open({ name: "issues" });
}
