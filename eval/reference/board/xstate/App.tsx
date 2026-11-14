import { AppActor } from "./appMachine";
import BoardPage from "./board/BoardPage";
import ArchivePage from "./archive/ArchivePage";

export default function App() {
  return (
    <AppActor.Provider>
      <Tabs />
    </AppActor.Provider>
  );
}

function Tabs() {
  const app = AppActor.useActorRef();
  const page = AppActor.useSelector(s => (s.matches("board") ? "board" : "archive"));
  const { board, archive } = AppActor.useSelector(s => s.children);
  return (
    <div>
      <nav>
        <button type="button" data-testid="tab-board" aria-pressed={page === "board"} onClick={() => app.send({ type: "tab.board" })}>
          Board
        </button>{" "}
        <button type="button" data-testid="tab-archive" aria-pressed={page === "archive"} onClick={() => app.send({ type: "tab.archive" })}>
          Archive
        </button>
      </nav>
      {board && <BoardPage key={board.sessionId} actor={board} />}
      {archive && <ArchivePage key={archive.sessionId} actor={archive} />}
    </div>
  );
}
