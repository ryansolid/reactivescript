import type { Column } from "./api";
import { COLUMN_NAME, countItems, type ItemRow } from "./board";
import { errorMessage } from "./errors";

type Props = {
  /** the selected card as the board shows it; null while nothing is selected */
  card: { id: number; title: string; column: Column } | null;
  titleInput: string;
  onTitleInput: (v: string) => void;
  onRename: () => void;
  renameError: string | null;
  onArchive: () => void;
  /** the checklist as shown; undefined until it has loaded */
  items: ItemRow[] | undefined;
  checklistError: unknown;
  onToggle: (itemId: number, done: boolean) => void;
  itemInput: string;
  onItemInput: (v: string) => void;
  onAddItem: () => void;
  itemError: string | null;
};

export default function Detail(p: Props) {
  const { card, items } = p;
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
        <input data-testid="title-input" value={p.titleInput} onChange={e => p.onTitleInput(e.target.value)} placeholder="new title" />{" "}
        <button type="button" data-testid="rename" onClick={p.onRename}>
          rename
        </button>{" "}
        <button type="button" data-testid="archive" onClick={p.onArchive}>
          archive
        </button>
      </div>
      {p.renameError !== null && <p>rename error: {p.renameError}</p>}
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
                    <button type="button" data-testid="toggle" onClick={() => p.onToggle(r.id, !r.done)}>
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
        ) : p.checklistError ? (
          <p>checklist error: {errorMessage(p.checklistError)}</p>
        ) : (
          <p>loading checklist</p>
        )}
      </div>
      <div>
        <input data-testid="item-input" value={p.itemInput} onChange={e => p.onItemInput(e.target.value)} placeholder="new item" />{" "}
        <button type="button" data-testid="add-item" disabled={!items} onClick={p.onAddItem}>
          add item
        </button>
      </div>
      {p.itemError !== null && <p>item error: {p.itemError}</p>}
    </section>
  );
}
