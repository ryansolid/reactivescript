import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BoardPage from "./BoardPage";
import ArchivePage from "./ArchivePage";

type Page = "board" | "archive";

// Each page gets its own query cache, made when the page opens, so leaving a page discards what it loaded; a write
// that answers after its page was left patches only the discarded cache.
function PageClient({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export default function App() {
  const [page, setPage] = useState<Page>("board");
  return (
    <div>
      <nav>
        <button type="button" data-testid="tab-board" aria-pressed={page === "board"} onClick={() => setPage("board")}>
          Board
        </button>{" "}
        <button type="button" data-testid="tab-archive" aria-pressed={page === "archive"} onClick={() => setPage("archive")}>
          Archive
        </button>
      </nav>
      <PageClient key={page}>{page === "board" ? <BoardPage /> : <ArchivePage />}</PageClient>
    </div>
  );
}
