// Upstream failure-class and wire helpers shared by compiled RX and this package's native primitives. Browser-safe:
// it must not pull in the interpreter or Node built-ins, because primitives.ts is bundled for the browser.
export { caughtValue, isA, makeErrorClass, wireCopy, wireFailure, PANIC } from "#rx/src/failure.ts";
