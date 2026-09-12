import { createSixbError } from "../../errors/internal"
import type { AgentQueueJob, Queue } from "../../queues"
import { modelCallRecoveryPayload } from "./model-call-recovery"
import type { RecoverAiModelCallInput } from "./types"

/** Stable queue identity: a lost enqueue response can safely retry the same accounting handoff. */
function agentAiUsageRecoveryJobId(recordId: string): string {
  return `agt_usage_job_${recordId}`
}

/** Transport adapter for the agent worker's existing durable recovery lane. */
export async function enqueueAiModelCallRecovery(
  queue: Pick<Queue<AgentQueueJob>, "enqueue">,
  input: RecoverAiModelCallInput
): Promise<void> {
  const payload = modelCallRecoveryPayload(input)
  const record = input.usage
  const jobId = agentAiUsageRecoveryJobId(record.id)
  const [job] = await queue.enqueue({
    projectId: record.projectId,
    jobs: [{ id: jobId, type: "agent.ai-usage.record.requested", payload }],
  })

  if (job?.id !== jobId || job.type !== "agent.ai-usage.record.requested") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbModels] Agent queue did not confirm AI usage recovery job '${jobId}'.`,
      { details: { jobId } }
    )
  }
}
