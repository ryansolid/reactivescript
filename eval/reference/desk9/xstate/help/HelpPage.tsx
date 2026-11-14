import { useSelector } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import type { helpMachine } from "./helpMachine";

export default function HelpPage({ actor }: { actor: ActorRefFrom<typeof helpMachine> }) {
  const state = useSelector(actor, s => s);
  const { context } = state;
  const { send } = actor;
  const { results } = context;
  return (
    <main>
      <input data-testid="query" value={context.query} onChange={e => send({ type: "query.change", value: e.target.value })} />{" "}
      <section data-testid="results">
        {state.matches({ search: "tooShort" }) && <p>too short: {context.query}</p>}
        {state.matches({ search: "searching" }) && <p>searching…</p>}
        {state.matches({ search: "failed" }) && <p>search failed: {context.searchError}</p>}
        {results && (
          <div>
            <h2>
              {results.hits.length} results for {results.query}
            </h2>
            <ul>
              {results.hits.map(hit => (
                <li key={hit.id} data-testid="hit" onClick={() => send({ type: "hit.select", id: hit.id })}>
                  {hit.id === context.selected ? "> " : ""}
                  {hit.name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>{" "}
      <section data-testid="item">
        {state.matches({ item: "none" }) ? (
          <p>pick a result</p>
        ) : state.matches({ item: "loading" }) ? (
          <p>loading…</p>
        ) : state.matches({ item: "notFound" }) ? (
          <p>item {context.selected} not found</p>
        ) : state.matches({ item: "failed" }) ? (
          <>
            <p>failed: {context.itemError}</p>{" "}
            <button type="button" data-testid="retry-item" onClick={() => send({ type: "item.retry" })}>
              retry
            </button>
          </>
        ) : (
          context.item && (
            <article>
              <h3>{context.item.name}</h3> <p>{context.item.blurb}</p>
            </article>
          )
        )}
      </section>
    </main>
  );
}
