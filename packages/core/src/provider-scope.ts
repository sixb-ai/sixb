/**
 * Whether a provider reaches beyond the process that created it.
 *
 * Required on {@link Broker} and {@link Queues}, with no default. A production deployment runs
 * the API, the orchestrator and the workers as separate processes: a `"process"` provider gives
 * each of them a private lane, so work is published where nobody can see it and the system looks
 * alive while doing nothing. Production roles refuse to start against one, and they can only
 * refuse what the provider declares — an optional marker was read as `"shared"` when omitted.
 */
export type ProviderScope =
  /** Holds its state in this process: in-memory, or a per-process file handle. */
  | "process"
  /** Reaches a service every process can reach: Redis, NATS, Postgres. */
  | "shared"
