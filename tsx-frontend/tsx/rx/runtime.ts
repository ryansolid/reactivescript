// Upstream runtimes the frontend and its tests execute against: the reference interpreter, the compiled-module runtime
// (rt.ts, rt-web.ts, rt-server.ts), the string renderer and the failure/wire helpers the native primitives share with
// compiled RX. These are private upstream modules, not a published API, so every import of them is centralized here.
import { fileURLToPath } from "node:url";
export { Runtime, ErrVal, PENDING } from "#rx/src/runtime.ts";
export { createApp, flush } from "#rx/compile/rt.ts";
export { caughtValue, isA, makeErrorClass, wireCopy, wireFailure, PANIC } from "./failure.ts";
export { R, serialize, createElement, setProp } from "#rx/compile/string-renderer.ts";

/** Absolute paths of upstream runtime files that tests hand to bundlers or Solid's compiler as module specifiers. */
export const runtimeFiles = {
  stringRenderer: fileURLToPath(import.meta.resolve("#rx/compile/string-renderer.ts")),
  web: fileURLToPath(import.meta.resolve("#rx/compile/rt-web.ts")),
  server: fileURLToPath(import.meta.resolve("#rx/compile/rt-server.ts")),
};
