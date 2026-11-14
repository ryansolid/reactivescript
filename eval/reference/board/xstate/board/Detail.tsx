import type { Column } from "../api";
import { COLUMN_NAME, countItems, type ItemRow } from "./lay";
import type { BoardActor } from "./BoardPage";

type Props = {
  /** the selected card as the board shows it; null while nothing is selected */
  card: { id: number; title: string; column: Column } | null;
  /** its checklist as shown; null until it has loaded */
  items: ItemRow[] | null;
  checklistError: string | null;
  titleInput: string;
  itemInput: string;
  renameError: string | null;
  itemError: string | null;
  send: BoardActor["send"];
};

export default function Detail({ card, items, checklistError, titleInput, itemInput, renameError, itemError, send }: Props) {
  if (!card)
    return (
      <section data-testid="detail">
        <p>select a card</p>
      </section>
    );
  const { done, total } = items ? countItems(items) : { done: 0, total: 0 };
  return (
    <section data-testid="detail" style={{ minWidth: "16rem" }}>
      <h2>
        #{card.id} {card.title}
      </h2>
      <p>in {COLUMN_NAME[card.column]}</p>
      <div>
        <input
          data-testid="title-input"
          value={titleInput}
          onChange={e => send({ type: "title.change", value: e.target.value })}
          placeholder="new title"
        />{" "}
        <button type="button" data-testid="rename" onClick={() => send({ type: "card.rename" })}>
          rename
        </button>{" "}
        <button type="button" data-testid="archive" onClick={() => send({ type: "card.archive" })}>
          archive
        </button>
      </div>
      {renameError !== null && <p>rename error: {renameError}</p>}
      <div data-testid="checklist">
        {items ? (
          <>
            <ul>
              {items.map(r =>
                r.kind === "adding" ? (
                  <li key={`adding-${r.seq}`}>
                    <span data-testid="item">[ ] {r.text} (adding…)</span>
                  </li>
                ) : (
                  <li key={r.id}>
                    <span data-testid="item">
                      [{r.done ? "x" : " "}] {r.text}
                    </span>{" "}
                    <button type="button" data-testid="toggle" onClick={() => send({ type: "item.toggle", itemId: r.id, done: !r.done })}>
                      toggle
                    </button>
                  </li>
                ),
              )}
            </ul>
            <p data-testid="progress">
              {done}/{total} done
            </p>
          </>
        ) : checklistError !== null ? (
          <p>checklist error: {checklistError}</p>
        ) : (
          <p>loading checklist</p>
        )}
      </div>
      <div>
        <input data-testid="item-input" value={itemInput} onChange={e => send({ type: "item.change", value: e.target.value })} placeholder="new item" />{" "}
        <button type="button" data-testid="add-item" disabled={!items} onClick={() => send({ type: "item.add" })}>
          add item
        </button>
      </div>
      {itemError !== null && <p>item error: {itemError}</p>}
    </section>
  );
}
