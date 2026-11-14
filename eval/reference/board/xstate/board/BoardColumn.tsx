import type { ReactNode } from "react";
import type { Column } from "../api";
import { COLUMNS, COLUMN_NAME } from "./lay";
import { canEnter, type ShownBoard } from "./boardMachine";
import type { BoardActor } from "./BoardPage";

type Props = {
  column: Column;
  board: ShownBoard;
  /** the load's failure, while the column shows it */
  failed: string | null;
  selected: number | null;
  send: BoardActor["send"];
  footer?: ReactNode;
};

export default function BoardColumn({ column, board, failed, selected, send, footer }: Props) {
  const rows = board[column];
  const at = COLUMNS.indexOf(column);
  const left = COLUMNS[at - 1];
  const right = COLUMNS[at + 1];
  const moveTo = (id: number, target: Column, index: number) => send({ type: "card.move", id, column: target, index });
  const toBottom = (id: number, target: Column) => moveTo(id, target, board[target]?.length ?? 0);
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
                <button type="button" data-testid="card" aria-pressed={r.id === selected} onClick={() => send({ type: "card.select", id: r.id })}>
                  #{r.id} {r.title} · {r.done}/{r.total}
                </button>{" "}
                {left && (
                  <button type="button" data-testid="left" disabled={!canEnter(board, left)} onClick={() => toBottom(r.id, left)}>
                    left
                  </button>
                )}
                {right && (
                  <button type="button" data-testid="right" disabled={!canEnter(board, right)} onClick={() => toBottom(r.id, right)}>
                    right
                  </button>
                )}
                {i > 0 && (
                  <button type="button" data-testid="up" onClick={() => moveTo(r.id, column, i - 1)}>
                    up
                  </button>
                )}
                {i < rows.length - 1 && (
                  <button type="button" data-testid="down" onClick={() => moveTo(r.id, column, i + 1)}>
                    down
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      ) : failed !== null ? (
        <p>
          error: {failed}{" "}
          <button type="button" data-testid={`retry-${column}`} onClick={() => send({ type: "column.retry", column })}>
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
