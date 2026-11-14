import { useSelector } from "@xstate/react";
import type { ActorRefFrom } from "xstate";
import { shownRows, type archiveMachine } from "./archiveMachine";

export default function ArchivePage({ actor }: { actor: ActorRefFrom<typeof archiveMachine> }) {
  const state = useSelector(actor, s => s);
  const { context } = state;
  const { send } = actor;
  return (
    <section>
      <div data-testid="archived">
        {state.matches("loading") ? (
          <p>loading archive</p>
        ) : state.matches("failed") ? (
          <p>archive error: {context.loadError}</p>
        ) : (
          <ul>
            {shownRows(context).map(a => (
              <li key={a.id}>
                <span data-testid="archived-card">
                  #{a.id} {a.title}
                </span>{" "}
                <button type="button" data-testid="restore" onClick={() => send({ type: "restore", id: a.id })}>
                  restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {context.restoreError !== null && <p data-testid="restore-error">restore error: {context.restoreError}</p>}
    </section>
  );
}
