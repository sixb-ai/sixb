import { AgentStorageError } from "../storage/agents"

/** This session's execution token is stale, so it must make no further durable writes. */
export class AgentExecutionLostError extends Error {
  readonly name = "AgentExecutionLostError"
  constructor(readonly runId: string) {
    super(`[Sixb] Lost execution ownership of agent run '${runId}'.`)
  }
}

/**
 * Storage outcomes that mean the run is no longer this session's: another delivery owns it, or it
 * already ended. There is nothing more to record either way.
 */
export function isTerminalOrExecutionGone(error: unknown): boolean {
  return (
    error instanceof AgentStorageError &&
    (error.code === "execution_lost" ||
      error.code === "invalid_state" ||
      error.code === "run_not_found")
  )
}

/**
 * Make a write the run's token fences, and report the fence as {@link AgentExecutionLostError}: a
 * runner checks for that one error, whichever write found the run gone. `ended` also counts a run
 * that ended as gone, for a write whose storage says so with `invalid_state`.
 */
export async function fenced<T>(
  runId: string,
  write: () => Promise<T>,
  options: { readonly ended?: boolean } = {}
): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const gone = options.ended
      ? isTerminalOrExecutionGone(error)
      : error instanceof AgentStorageError &&
        (error.code === "execution_lost" || error.code === "run_not_found")
    if (gone) throw new AgentExecutionLostError(runId)
    throw error
  }
}
