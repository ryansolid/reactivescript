// A value the server holds, as one page knows it: the server's last word on it, with this page's writes still in the
// air laid over it.

/** orders a page's requests and answers; one per page visit */
export class Clock {
  private now = 0;
  tick() {
    return ++this.now;
  }
}

export class Register<T> {
  /** what the server last said; `at` is when it said it, on the page's clock */
  private known: { value: T; at: number } | undefined;
  /** writes in the air, oldest first */
  private writes: { seq: number; value: T }[] = [];
  /** the write whose answer `known` holds: writes started before it are no news once it has answered */
  private answeredSeq = 0;

  constructor(private readonly clock: Clock) {}

  /** a read of the server that was asked at `askedAt` answered `value`; an answer to a newer question wins */
  learn(value: T, askedAt: number) {
    if (!this.known || askedAt >= this.known.at) this.known = { value, at: askedAt };
  }

  /**
   * What to show: the newest write still in the air, unless the server has since answered a newer one; otherwise
   * the server's last word (`fallback` until it has said anything).
   */
  shown(fallback: T): T {
    const guess = this.guess();
    if (guess) return guess.value;
    return this.known ? this.known.value : fallback;
  }

  /** whether what shows is a write still in the air */
  guessing() {
    return this.guess() !== undefined;
  }

  private guess() {
    const newest = this.writes.at(-1);
    return newest && newest.seq > this.answeredSeq ? newest : undefined;
  }

  /** starts a write of `value`; call `accepted` or `declined` when the server answers */
  write(value: T) {
    const seq = this.clock.tick();
    this.writes.push({ seq, value });
    const done = () => {
      this.writes = this.writes.filter(w => w.seq !== seq);
    };
    return {
      accepted: (saved: T) => {
        done();
        this.known = { value: saved, at: this.clock.tick() };
        this.answeredSeq = seq;
      },
      declined: done,
    };
  }
}
