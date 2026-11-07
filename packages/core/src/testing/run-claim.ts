import type { ClaimRunInput, ReleaseRunExecutionInput, RunClaim, RunExecution } from "../storage"
import type { HeldRunClaim } from "../workers/run-worker"

/** An execution that holds a run for as long as a fixture needs it. */
export function testRunExecution(runId: string, token = `test_token:${runId}`): RunExecution {
  return { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) }
}

/** Claim a run the way a worker's delivery does, and hold it. */
export async function claimTestRun<TRun>(
  runs: { startOrReclaim(input: ClaimRunInput): Promise<RunClaim<TRun>> },
  input: { readonly projectId: string; readonly id: string; readonly token?: string }
): Promise<HeldRunClaim<TRun>> {
  const execution = testRunExecution(input.id, input.token)
  const claim = await runs.startOrReclaim({
    projectId: input.projectId,
    id: input.id,
    execution,
  })

  if (claim.outcome !== "started" && claim.outcome !== "resumed") {
    throw new Error(`[Test] Run '${input.id}' could not be claimed: it is ${claim.outcome}.`)
  }

  return { ...claim, execution }
}

/**
 * Move a queued run to running without a worker. With no `execution` it is handed back at once, so
 * that a fixture can finish it without playing the execution that held it.
 */
export async function startTestRun<TRun>(
  runs: {
    startOrReclaim(input: ClaimRunInput): Promise<RunClaim<TRun>>
    releaseExecution(input: ReleaseRunExecutionInput): Promise<void>
    getById(params: { projectId: string; id: string }): Promise<TRun | null>
  },
  input: {
    readonly projectId: string
    readonly id: string
    readonly startedAt?: Date
    readonly execution?: RunExecution
  }
): Promise<TRun> {
  const execution = input.execution ?? testRunExecution(input.id)
  const claim = await runs.startOrReclaim({
    projectId: input.projectId,
    id: input.id,
    execution,
    claimedAt: input.startedAt,
  })

  if (claim.outcome !== "started") {
    throw new Error(`[Test] Run '${input.id}' could not start: it is ${claim.outcome}.`)
  }

  if (input.execution) return claim.run

  await runs.releaseExecution({
    projectId: input.projectId,
    id: input.id,
    executionToken: execution.token,
    spentAttempt: true,
  })

  const run = await runs.getById({ projectId: input.projectId, id: input.id })
  if (!run) throw new Error(`[Test] Run '${input.id}' was not found.`)
  return run
}
