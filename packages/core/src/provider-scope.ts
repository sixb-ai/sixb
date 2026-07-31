/**
 * Whether a provider reaches beyond the process that created it.
 *
 * Required on {@link Broker} and {@link Queues}, with no default. A production
 * deployment runs the API, the orchestrator and the workers as separate processes: one
 * publishes, another claims. A provider that only works inside one process gives each
 * of them a private lane, so work is published where nobody can see it and the system
 * looks alive while doing nothing. Production roles refuse to start against one — and
 * they can only refuse what the provider declares.
 *
 * An optional marker put the cost of forgetting on the operator: a process-local
 * provider that did not declare itself was read as shareable and started in
 * production. Required means the question is answered where the provider is written,
 * and answered by every provider, including test doubles.
 */
export type ProviderScope =
  /** Holds its state in this process: in-memory, or a per-process file handle. */
  | "process"
  /** Reaches a service every process can reach: Redis, NATS, Postgres. */
  | "shared"
