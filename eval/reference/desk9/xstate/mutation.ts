import { fromCallback, type EventObject } from "xstate";

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a mutation actor tells its parent when the server answers. */
export type MutationEvent<TInput, TOutput> =
  | { type: "mutation.succeeded"; input: TInput; output: TOutput }
  | { type: "mutation.failed"; input: TInput; message: string };

/**
 * Logic for one write to the server, spawned once per write so that any number can be in flight at once. It reports
 * back to its parent with a `MutationEvent` carrying its input; once stopped (its parent stopped, or it was cleaned up
 * after reporting) it reports nothing, so an answer for a page that was left never reaches anything.
 */
export function mutation<TInput, TOutput>(request: (input: TInput) => Promise<TOutput>) {
  return fromCallback<EventObject, TInput>(({ input, sendBack }) => {
    let live = true;
    request(input).then(
      output => {
        if (live) sendBack({ type: "mutation.succeeded", input, output } satisfies MutationEvent<TInput, TOutput>);
      },
      (error: unknown) => {
        if (live) sendBack({ type: "mutation.failed", input, message: errorMessage(error) } satisfies MutationEvent<TInput, TOutput>);
      },
    );
    return () => {
      live = false;
    };
  });
}
