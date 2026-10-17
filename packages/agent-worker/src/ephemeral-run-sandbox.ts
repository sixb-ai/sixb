import type { RunSandbox } from "./run-sandbox"
import type { AgentExecutionContext } from "./types"

interface EphemeralRunSandboxInput {
  /** The run's context: its project factory creates the sandbox, which reaches its Sixb API. */
  readonly context: Pick<AgentExecutionContext, "sandboxes" | "apiBaseUrl">
  /**
   * Cancels creation: on cancellation, lost ownership, worker shutdown (which aborts the queue
   * delivery) or a deadline. It must never fire because the run completed: a sandbox still
   * booting then would be abandoned to the provider's failure cleanup instead of destroyed.
   */
  readonly signal?: AbortSignal
}

/**
 * A sandbox created for one run and destroyed when the run releases it.
 *
 * It is blank: no source or setup, and only the Sixb API on the network. The prompt describes
 * nothing about it, so it boots concurrently with the first model call.
 */
export function ephemeralRunSandbox(input: EphemeralRunSandboxInput): RunSandbox {
  const { context, signal } = input
  const apiOrigin = new URL(context.apiBaseUrl).origin

  return {
    waitBeforeModel: false,
    acquire: async () => ({
      sandbox: await context.sandboxes.create({
        environment: {},
        network: { mode: "restricted", allow: [{ name: "sixb-api", origin: apiOrigin }] },
        ...(signal ? { signal } : {}),
      }),
    }),
    release: (acquired) => acquired.sandbox.destroy(),
  }
}
