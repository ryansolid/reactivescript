import type { ReactNode } from "react";
import type { Column } from "./api";
import { COLUMNS, COLUMN_NAME } from "./board";
import { errorMessage } from "./errors";

/** a card as the board shows it, or one being added (no id yet) */
export type ShownRow = { kind: "card"; id: number; title: string; done: number; total: number } | { kind: "adding"; seq: number; title: string };

type Props = {
  column: Column;
  /** undefined until the column has loaded */
  rows: ShownRow[] | undefined;
  /** the load's failure, while it is not being asked again */
  error: unknown;
  onRetry: () => void;
  /** whether a card from another column may move into `target`, and how many cards `target` shows */
  canEnter: (target: Column) => boolean;
  sizeOf: (target: Column) => number;
  selected: number | null;
  onSelect: (id: number) => void;
  onMove: (id: number, column: Column, index: number) => void;
  footer?: ReactNode;
};

export default function BoardColumn({ column, rows, error, onRetry, canEnter, sizeOf, selected, onSelect, onMove, footer }: Props) {
  const at = COLUMNS.indexOf(column);
  const left = COLUMNS[at - 1];
  const right = COLUMNS[at + 1];
  return (
    <section data-testid={`col-${column}`} style={{ minWidth: "14rem" }}>
      <h2 data-testid={`head-${column}`}>
        {COLUMN_NAME[column]}
        {rows ? ` (${rows.length})` : ""}
      </h2>
      {rows ? (
        <ul>
          {rows.map((r, i) =>
            r.kind === "adding" ? (
              <li key={`adding-${r.seq}`}>
                <span data-testid="card">{r.title} (adding…)</span>
              </li>
            ) : (
              <li key={r.id}>
                <button type="button" data-testid="card" aria-pressed={r.id === selected} onClick={() => onSelect(r.id)}>
                  #{r.id} {r.title} · {r.done}/{r.total}
                </button>{" "}
                {left && (
                  <button type="button" data-testid="left" disabled={!canEnter(left)} onClick={() => onMove(r.id, left, sizeOf(left))}>
                    left
                  </button>
                )}
                {right && (
                  <button type="button" data-testid="right" disabled={!canEnter(right)} onClick={() => onMove(r.id, right, sizeOf(right))}>
                    right
                  </button>
                )}
                {i > 0 && (
                  <button type="button" data-testid="up" onClick={() => onMove(r.id, column, i - 1)}>
                    up
                  </button>
                )}
                {i < rows.length - 1 && (
                  <button type="button" data-testid="down" onClick={() => onMove(r.id, column, i + 1)}>
                    down
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      ) : error ? (
        <p>
          error: {errorMessage(error)}{" "}
          <button type="button" data-testid={`retry-${column}`} onClick={onRetry}>
            retry
          </button>
        </p>
      ) : (
        <p>loading</p>
      )}
      {footer}
    </section>
  );
}
