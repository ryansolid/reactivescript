// Upstream's AC-1b/AC-1c reading of an imperative body, used to decide which plain Solid callbacks have a faithful RX
// spelling. Upstream infers an arrow that guesses, declares `affects`, or writes and awaits as an action, and holds its
// writes that precede an `await`; Solid never infers actions, so such a callback applies those writes immediately.
import { inferredAction, runFindings, triggerText, type Trigger } from "#rx/src/infer.ts";
import type { Stmt } from "./ast.ts";

export type ActionInference = { trigger: Trigger | null; why: string | null; held: string[] };

export function actionInference(stmts: Stmt[]): ActionInference {
  const trigger = inferredAction(stmts);
  if (!trigger) return { trigger, why: null, held: [] };
  const held = runFindings(stmts, true, [], true).filter(f => f.code === "HELD_WRITE").map(f => f.name);
  return { trigger, why: triggerText(trigger), held };
}
