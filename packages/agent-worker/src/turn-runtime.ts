import type { AuthorizablePrincipal } from "@sixb/core"
import {
  AiModelCallRecorder,
  createAiModelCallLimitController,
} from "@sixb/core/internal/model-execution"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { AgentRunRecord } from "@sixb/core/storage"
import { AgentTurnTimeoutError } from "./errors"
import type { AgentTurnContext } from "./types"

export interface AgentTurnRuntime {
  /** Worker shutdown, queue-lease loss, and user cancellation before the turn deadline is added. */
  readonly sourceSignal: AbortSignal
  /** Complete run signal, including the one wall-clock deadline shared by preflight and generation. */
  readonly signal: AbortSignal
  readonly usageRecorder: AiModelCallRecorder
  readonly timedOut: () => boolean
  /** Surface ownership, accounting, timeout, or cancellation before another durable action. */
  readonly assertCanContinue: () => void
  dispose(): void
}

/** Start the run-owned accounting and wall-clock boundary before any optional compaction work. */
export function createAgentTurnRuntime(input: {
  readonly context: Pick<
    AgentTurnContext,
    "id" | "storage" | "recoverAiModelCall" | "turnTimeoutMs"
  >
  readonly run: AgentRunRecord
  readonly signal: AbortSignal
  readonly requestedBy?: AuthorizablePrincipal
}): AgentTurnRuntime {
  const modelCallLimits = createAiModelCallLimitController({
    storage: input.context.storage,
    projectId: input.context.id,
    requestedBy: input.requestedBy,
    requesterGroupIds: input.run.requesterGroupIds,
  })
  const usageRecorder = new AiModelCallRecorder({
    storage: input.context.storage,
    projectId: input.context.id,
    executionId: input.run.executionId,
    attempt: input.run.attempt,
    requesterGroupIds: input.run.requesterGroupIds,
    limits: modelCallLimits,
    recoverAiModelCall: input.context.recoverAiModelCall,
  })
  const timeout = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort()
  }, input.context.turnTimeoutMs)

  return {
    sourceSignal: input.signal,
    signal: AbortSignal.any([input.signal, timeout.signal]),
    usageRecorder,
    timedOut: () => timedOut,
    assertCanContinue() {
      if (input.signal.reason instanceof QueueDeliveryLeaseLostError) {
        throw input.signal.reason
      }
      usageRecorder.assertHealthy()
      if (timedOut) {
        throw new AgentTurnTimeoutError(input.run.id, input.context.turnTimeoutMs)
      }
      input.signal.throwIfAborted()
    },
    dispose() {
      clearTimeout(timer)
    },
  }
}
