import { Effect } from 'effect'

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const request = <A>(call: () => Promise<A>): Effect.Effect<A, string> =>
  Effect.tryPromise({ try: call, catch: errorMessage })
