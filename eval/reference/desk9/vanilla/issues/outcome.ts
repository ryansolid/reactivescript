// What a write came to, and the error line its kind of action shows.
import { h } from "../dom";

/** `null` when the server took the write, else the server's message */
export type Outcome = string | null;

/**
 * An error line that the newest action of its kind owns: starting one clears it, and only the newest one reports its
 * failure, while `signal` (the selection or page it belongs to) lasts.
 */
export class ActionError {
  private seq = 0;
  private message: string | null = null;

  constructor(
    private readonly signal: AbortSignal,
    private readonly render: () => void,
  ) {}

  async run(action: () => Promise<Outcome>) {
    const seq = ++this.seq;
    this.message = null;
    const outcome = await action();
    if (outcome !== null && seq === this.seq && !this.signal.aborted) {
      this.message = outcome;
      this.render();
    }
  }

  /** the line to show (`prefix` and the message), or nothing */
  line(prefix: string, testid?: string) {
    return this.message === null ? "" : h("p", { className: "error", testid }, prefix + this.message);
  }
}
