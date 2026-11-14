import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IssuesPage from "./IssuesPage";
import HelpPage from "./HelpPage";
import SettingsPage from "./SettingsPage";

type Page = "issues" | "help" | "settings";

// Each page gets its own query cache, made when the page opens, so leaving a page discards what it loaded.
function PageClient({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export default function App() {
  const [page, setPage] = useState<Page>("issues");
  // the number of open issues the issues page last showed; null until they have loaded once
  const [openCount, setOpenCount] = useState<number | null>(null);
  // where the help page opens: empty from its tab, on an issue's title from a related hit; every opening is a new visit
  const [help, setHelp] = useState<{ query: string; selected: number | null; visit: number }>({ query: "", selected: null, visit: 0 });
  const openHelp = (query: string, selected: number | null) => {
    setHelp(h => ({ query, selected, visit: h.visit + 1 }));
    setPage("help");
  };
  return (
    <div>
      <nav>
        <button type="button" data-testid="tab-issues" onClick={() => setPage("issues")}>
          Issues{openCount === null ? "" : ` (${openCount})`}
        </button>{" "}
        <button type="button" data-testid="tab-help" onClick={() => openHelp("", null)}>
          Help
        </button>{" "}
        <button type="button" data-testid="tab-settings" onClick={() => setPage("settings")}>
          Settings
        </button>
      </nav>
      <PageClient key={page === "help" ? `help-${help.visit}` : page}>
        {page === "issues" ? (
          <IssuesPage onOpenCount={setOpenCount} onOpenHelp={openHelp} />
        ) : page === "help" ? (
          <HelpPage initialQuery={help.query} initialSelected={help.selected} />
        ) : (
          <SettingsPage />
        )}
      </PageClient>
    </div>
  );
}
