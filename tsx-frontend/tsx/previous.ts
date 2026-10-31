import { createMemo, type Accessor } from "solid-js";

/** History starts with this companion's owner lifetime; declare it alongside its input. */
export function createPrevious<T>(input: Accessor<T>, fallback: () => T): Accessor<T>;
export function createPrevious<T>(input: Accessor<T>, fallback?: () => T): Accessor<T | undefined>;
export function createPrevious<T>(input: Accessor<T>, fallback?: () => T): Accessor<T | undefined> {
  const packet = createMemo<{ cur: T; prev: T | undefined }>(previous => ({
    cur: input(),
    prev: previous?.cur,
  }));
  return createMemo(() => {
    const previous = packet().prev;
    return previous === undefined ? fallback?.() : previous;
  }, { lazy: true });
}
