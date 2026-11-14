import { useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { addCard, addItem, archiveCard, fetchCards, fetchChecklist, moveCard, renameCard, toggleItem, type Column } from "./api";
import {
  COLUMNS,
  WIP_LIMIT,
  addSlot,
  countItems,
  isColumn,
  layColumns,
  layItems,
  newest,
  placeCard,
  type Archiving,
  type CachedCard,
  type CachedItem,
  type CardAdd,
  type ItemAdd,
  type Move,
  type Rename,
  type Toggle,
} from "./board";
import { errorIn, errorMessage, type VisitError } from "./errors";
import BoardColumn, { type ShownRow } from "./BoardColumn";
import Detail from "./Detail";

const cardsKey = (c: Column) => ["cards", c];
const checklistKey = (id: number) => ["checklist", id];

export default function BoardPage() {
  const queryClient = useQueryClient();
  const seqRef = useRef(0);
  const nextSeq = () => ++seqRef.current;

  const [selected, setSelected] = useState<number | null>(null);
  // counts selections: the detail's inputs and errors belong to one selection
  const [visit, setVisit] = useState(0);
  const [titleInput, setTitleInput] = useState("");
  const [itemInput, setItemInput] = useState("");
  const [newCard, setNewCard] = useState("");

  // writes in the air
  const [moves, setMoves] = useState<Move[]>([]);
  const [adds, setAdds] = useState<CardAdd[]>([]);
  const [archiving, setArchiving] = useState<Archiving[]>([]);
  const [renames, setRenames] = useState<Rename[]>([]);
  const [toggles, setToggles] = useState<Toggle[]>([]);
  const [itemAdds, setItemAdds] = useState<ItemAdd[]>([]);

  const [moveError, setMoveError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<VisitError | null>(null);
  const [itemError, setItemError] = useState<VisitError | null>(null);

  const columnQueries = useQueries({
    queries: COLUMNS.map(c => ({ queryKey: cardsKey(c), queryFn: (): Promise<CachedCard[]> => fetchCards(c) })),
  });
  const base = {} as Record<Column, CachedCard[] | undefined>;
  COLUMNS.forEach((c, i) => (base[c] = columnQueries[i].data));
  const laid = layColumns(base, moves, adds, archiving);

  // Checklists: the selected card's loads; every other card's stays as last answered for the page's life, so a card
  // whose checklist is known counts its items as the checklist shows them, writes in the air included.
  const cardIds = COLUMNS.flatMap(c => laid[c] ?? []).flatMap(r => (r.kind === "card" ? [r.card.id] : []));
  const checklistIds = selected !== null && !cardIds.includes(selected) ? [...cardIds, selected] : cardIds;
  const checklistQueries = useQueries({
    queries: checklistIds.map(id => ({
      queryKey: checklistKey(id),
      queryFn: (): Promise<CachedItem[]> => fetchChecklist(id),
      enabled: id === selected,
      gcTime: Infinity,
    })),
  });
  const itemsOf = (id: number) => {
    const list = checklistQueries[checklistIds.indexOf(id)]?.data;
    return list && layItems(list, toggles.filter(t => t.cardId === id), itemAdds.filter(a => a.cardId === id));
  };

  const shown = {} as Record<Column, ShownRow[] | undefined>;
  for (const c of COLUMNS)
    shown[c] = laid[c]?.map(r => {
      if (r.kind === "adding") return r;
      const items = itemsOf(r.card.id);
      const { done, total } = items ? countItems(items) : r.card;
      const title = newest(renames, n => n.id === r.card.id)?.title ?? r.card.title;
      return { kind: "card", id: r.card.id, title, done, total };
    });

  /** whether a card may move into `target` from another column: it has loaded, and Doing is under its limit */
  const canEnter = (target: Column) => {
    const rows = shown[target];
    return rows !== undefined && (target !== "doing" || rows.length < WIP_LIMIT);
  };

  // the server's answers go into the caches
  const setColumns = (f: (cols: Record<Column, CachedCard[] | undefined>) => Record<Column, CachedCard[] | undefined>) => {
    const cols = {} as Record<Column, CachedCard[] | undefined>;
    for (const c of COLUMNS) cols[c] = queryClient.getQueryData<CachedCard[]>(cardsKey(c));
    const next = f(cols);
    for (const c of COLUMNS) if (next[c] !== cols[c]) queryClient.setQueryData(cardsKey(c), next[c]);
  };
  const patchCard = (id: number, f: (card: CachedCard) => CachedCard) =>
    setColumns(cols => {
      const next = { ...cols };
      for (const c of COLUMNS) next[c] = cols[c]?.map(x => (x.id === id ? f(x) : x));
      return next;
    });

  const doMove = async (id: number, column: Column, index: number) => {
    const seq = nextSeq();
    setMoveError(null);
    setMoves(prev => [...prev, { seq, id, column, index }]);
    try {
      const res = await moveCard(id, column, index);
      const to = isColumn(res.column) ? res.column : column;
      setColumns(cols => placeCard(cols, res.id, to, res.index));
    } catch (e) {
      setMoveError(errorMessage(e));
    } finally {
      setMoves(prev => prev.filter(m => m.seq !== seq));
    }
  };

  const doAdd = async (title: string) => {
    const seq = nextSeq();
    setAddError(null);
    setNewCard("");
    setAdds(prev => [...prev, { seq, title }]);
    try {
      const res = await addCard("todo", title);
      queryClient.setQueryData<CachedCard[]>(cardsKey("todo"), old => {
        if (!old || old.some(x => x.id === res.id)) return old;
        const next = [...old];
        next.splice(addSlot(old, seq, x => x.addSeq), 0, { id: res.id, title: res.title, done: 0, total: 0, addSeq: seq });
        return next;
      });
    } catch (e) {
      setAddError(errorMessage(e));
    } finally {
      setAdds(prev => prev.filter(a => a.seq !== seq));
    }
  };

  const doRename = async (id: number, title: string) => {
    const seq = nextSeq();
    setRenameError(null);
    setRenames(prev => [...prev, { seq, id, title }]);
    try {
      const res = await renameCard(id, title);
      patchCard(res.id, x => ({ ...x, title: res.title }));
    } catch (e) {
      setRenameError({ visit, message: errorMessage(e) });
    } finally {
      setRenames(prev => prev.filter(n => n.seq !== seq));
    }
  };

  const doArchive = async (id: number) => {
    const seq = nextSeq();
    setArchiveError(null);
    setSelected(null);
    setArchiving(prev => [...prev, { seq, id }]);
    try {
      const res = await archiveCard(id);
      setColumns(cols => {
        const next = { ...cols };
        for (const c of COLUMNS) next[c] = cols[c]?.filter(x => x.id !== res.id);
        return next;
      });
    } catch (e) {
      setArchiveError(errorMessage(e));
    } finally {
      setArchiving(prev => prev.filter(a => a.seq !== seq));
    }
  };

  const doToggle = async (cardId: number, itemId: number, done: boolean) => {
    const seq = nextSeq();
    setItemError(null);
    setToggles(prev => [...prev, { seq, cardId, itemId, done }]);
    try {
      const res = await toggleItem(cardId, itemId, done);
      queryClient.setQueryData<CachedItem[]>(checklistKey(cardId), old => old?.map(i => (i.id === res.id ? { ...i, done: res.done } : i)));
    } catch (e) {
      setItemError({ visit, message: errorMessage(e) });
    } finally {
      setToggles(prev => prev.filter(t => t.seq !== seq));
    }
  };

  const doAddItem = async (cardId: number, text: string) => {
    const seq = nextSeq();
    setItemError(null);
    setItemInput("");
    setItemAdds(prev => [...prev, { seq, cardId, text }]);
    try {
      const res = await addItem(cardId, text);
      queryClient.setQueryData<CachedItem[]>(checklistKey(cardId), old => {
        if (!old || old.some(i => i.id === res.id)) return old;
        const next = [...old];
        next.splice(addSlot(old, seq, i => i.addSeq), 0, { ...res, addSeq: seq });
        return next;
      });
    } catch (e) {
      setItemError({ visit, message: errorMessage(e) });
    } finally {
      setItemAdds(prev => prev.filter(a => a.seq !== seq));
    }
  };

  const select = (id: number) => {
    setSelected(id);
    setVisit(v => v + 1);
    setTitleInput("");
    setItemInput("");
  };

  // the selected card as the board shows it
  let detailCard: { id: number; title: string; column: Column } | null = null;
  for (const c of COLUMNS)
    for (const r of shown[c] ?? []) if (r.kind === "card" && r.id === selected) detailCard = { id: r.id, title: r.title, column: c };
  const checklist = selected === null ? undefined : checklistQueries[checklistIds.indexOf(selected)];
  const items = detailCard && itemsOf(detailCard.id);

  return (
    <div>
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start" }}>
        {COLUMNS.map((c, i) => {
          const q = columnQueries[i];
          return (
            <BoardColumn
              key={c}
              column={c}
              rows={shown[c]}
              error={q.data === undefined && q.isError && !q.isFetching ? q.error : null}
              onRetry={() => void q.refetch()}
              canEnter={canEnter}
              sizeOf={target => shown[target]?.length ?? 0}
              selected={selected}
              onSelect={select}
              onMove={(id, column, index) => void doMove(id, column, index)}
              footer={
                c === "todo" && (
                  <div>
                    <input data-testid="new-card" value={newCard} onChange={e => setNewCard(e.target.value)} placeholder="new card" />{" "}
                    <button
                      type="button"
                      data-testid="add-card"
                      disabled={shown.todo === undefined}
                      onClick={() => {
                        if (newCard !== "") void doAdd(newCard);
                      }}
                    >
                      add
                    </button>
                    {addError !== null && <p data-testid="add-error">add error: {addError}</p>}
                  </div>
                )
              }
            />
          );
        })}
        <Detail
          card={detailCard}
          titleInput={titleInput}
          onTitleInput={setTitleInput}
          onRename={() => {
            if (detailCard && titleInput !== "") void doRename(detailCard.id, titleInput);
          }}
          renameError={errorIn(renameError, visit)}
          onArchive={() => {
            if (detailCard) void doArchive(detailCard.id);
          }}
          items={items ?? undefined}
          checklistError={checklist?.data === undefined && checklist?.isError && !checklist.isFetching ? checklist.error : null}
          onToggle={(itemId, done) => {
            if (detailCard) void doToggle(detailCard.id, itemId, done);
          }}
          itemInput={itemInput}
          onItemInput={setItemInput}
          onAddItem={() => {
            if (detailCard && items && itemInput !== "") void doAddItem(detailCard.id, itemInput);
          }}
          itemError={errorIn(itemError, visit)}
        />
      </div>
      {moveError !== null && <p data-testid="move-error">move error: {moveError}</p>}
      {archiveError !== null && <p data-testid="archive-error">archive error: {archiveError}</p>}
    </div>
  );
}
