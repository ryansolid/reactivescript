import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchItem, search, type Hit } from "./api";

// Opens on `initialQuery` with `initialSelected` chosen (both empty from the tab; a related hit opens it on its issue's
// title).
export default function HelpPage({ initialQuery = "", initialSelected = null }: { initialQuery?: string; initialSelected?: number | null }) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<number | null>(initialSelected);
  return (
    <main>
      <input data-testid="query" value={query} onChange={e => setQuery(e.target.value)} />{" "}
      {query !== "" && <Results query={query} selected={selected} onSelect={setSelected} />}{" "}
      <HelpItem id={selected} />
    </main>
  );
}

function Results({ query, selected, onSelect }: { query: string; selected: number | null; onSelect: (id: number) => void }) {
  const tooShort = query.length < 2;
  const { data, error, isFetching } = useQuery({
    queryKey: ["search", query],
    queryFn: () => search(query),
    enabled: !tooShort,
    placeholderData: keepPreviousData,
  });
  if (tooShort)
    return (
      <section data-testid="results">
        <p>too short: {query}</p>
      </section>
    );
  return (
    <section data-testid="results">
      {isFetching && <p>searching…</p>}
      {error && !isFetching ? (
        <p>search failed: {error.message}</p>
      ) : (
        data && (
          <div>
            <h2>
              {data.length} results for {query}
            </h2>
            <ul>
              {data.map((hit: Hit) => (
                <li key={hit.id} data-testid="hit" onClick={() => onSelect(hit.id)}>
                  {hit.id === selected ? "> " : ""}
                  {hit.name}
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </section>
  );
}

function HelpItem({ id }: { id: number | null }) {
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["item", id],
    queryFn: () => fetchItem(id!),
    enabled: id !== null,
  });
  if (id === null) return <p data-testid="item">pick a result</p>;
  return (
    <section data-testid="item">
      {isPending ? (
        <p>loading…</p>
      ) : error ? (
        <>
          <p>failed: {error.message}</p>{" "}
          <button data-testid="retry-item" onClick={() => refetch()}>
            retry
          </button>
        </>
      ) : data === null ? (
        <p>item {id} not found</p>
      ) : (
        <article>
          <h3>{data.name}</h3> <p>{data.blurb}</p>
        </article>
      )}
    </section>
  );
}
