import { useSelector } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { COLUMNS } from "./lay";
import { boardMachine, errorOf, selectedCard, shownBoard, shownItems } from "./boardMachine";
import BoardColumn from "./BoardColumn";
import Detail from "./Detail";

export type BoardActor = ActorRefFrom<typeof boardMachine>;

export default function BoardPage({ actor }: { actor: BoardActor }) {
  const state = useSelector(actor, s => s);
  const { context } = state;
  const { send } = actor;
  const board = shownBoard(context);
  const card = selectedCard(context, board);
  const addError = errorOf(context, "add");
  const moveError = errorOf(context, "move");
  const archiveError = errorOf(context, "archive");
  return (
    <div>
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start" }}>
        {COLUMNS.map(c => (
          <BoardColumn
            key={c}
            column={c}
            board={board}
            failed={state.matches({ [c]: "failed" }) ? context.cardsError[c] : null}
            selected={context.selected}
            send={send}
            footer={
              c === "todo" && (
                <div>
                  <input
                    data-testid="new-card"
                    value={context.newCard}
                    onChange={e => send({ type: "newCard.change", value: e.target.value })}
                    placeholder="new card"
                  />{" "}
                  <button type="button" data-testid="add-card" disabled={board.todo === null} onClick={() => send({ type: "card.add" })}>
                    add
                  </button>
                  {addError !== null && <p data-testid="add-error">add error: {addError}</p>}
                </div>
              )
            }
          />
        ))}
        <Detail
          card={card}
          items={card && shownItems(context, card.id)}
          checklistError={state.matches({ detail: "failed" }) ? context.checklistError : null}
          titleInput={context.titleInput}
          itemInput={context.itemInput}
          renameError={errorOf(context, "rename")}
          itemError={errorOf(context, "item")}
          send={send}
        />
      </div>
      {moveError !== null && <p data-testid="move-error">move error: {moveError}</p>}
      {archiveError !== null && <p data-testid="archive-error">archive error: {archiveError}</p>}
    </div>
  );
}
