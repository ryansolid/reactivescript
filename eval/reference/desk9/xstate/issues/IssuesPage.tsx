import { useSelector } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { issuesMachine, shownRows } from "./issuesMachine";
import IssueDetail from "./IssueDetail";

export type IssuesActor = ActorRefFrom<typeof issuesMachine>;

export default function IssuesPage({ actor }: { actor: IssuesActor }) {
  const state = useSelector(actor, s => s);
  const { context } = state;
  const { send } = actor;
  return (
    <div style={{ display: "flex", gap: "2rem" }}>
      <section>
        <label>
          user <input data-testid="user" value={context.user} onChange={e => send({ type: "user.change", value: e.target.value })} />
        </label>
        <div>
          {(["open", "closed"] as const).map(filter => (
            <button
              key={filter}
              type="button"
              data-testid={`filter-${filter}`}
              aria-pressed={context.filter === filter}
              onClick={() => send({ type: "filter.set", filter })}
            >
              {filter}
            </button>
          ))}
        </div>
        <div data-testid="list">
          {state.matches({ list: "loading" }) ? (
            <p>loading {context.filter} issues</p>
          ) : state.matches({ list: "failed" }) ? (
            <p>list error: {context.listError}</p>
          ) : (
            <ul>
              {shownRows(context).map(issue => (
                <li key={issue.id}>
                  <button
                    type="button"
                    data-testid="issue"
                    aria-pressed={issue.id === context.selected}
                    onClick={() => send({ type: "issue.select", id: issue.id })}
                  >
                    #{issue.id} {issue.title} ({issue.assignee ?? "unassigned"})
                  </button>{" "}
                  <button type="button" data-testid="row-assign" onClick={() => send({ type: "assign", issueId: issue.id, origin: "row" })}>
                    assign to {context.user}
                  </button>
                  {context.filter === "open" && (
                    <>
                      {" "}
                      <button type="button" data-testid="row-close" onClick={() => send({ type: "close", issueId: issue.id, origin: "row" })}>
                        close
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {context.errors.row && <p data-testid="row-error">row error: {context.errors.row}</p>}
      </section>
      <section data-testid="detail">
        {context.selected === null ? <p>select an issue</p> : <IssueDetail state={state} send={send} id={context.selected} />}
      </section>
    </div>
  );
}
