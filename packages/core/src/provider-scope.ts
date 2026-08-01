/**
 * Whether a provider reaches beyond the process that created it.
 *
 * Required on {@link Broker} and {@link Queues}, with no default: production roles refuse to
 * start against a `"process"` provider, and they can only refuse what the provider declares.
 */
export type ProviderScope =
  /** Holds its state in this process: in-memory, or a per-process file handle. */
  | "process"
  /** Reaches a service every process can reach: Redis, NATS, Postgres. */
  | "shared"
