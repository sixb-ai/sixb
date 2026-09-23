import type { ExecutionContext, RuntimeAuthorization } from "../../execution"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type { SixbHostContext } from "../../runtime/types"
import type { ModelExecutionAttempt } from "./binding"
import { requireAccountingCapabilities } from "./model-call-accounting"
import { createAiModelCallLimitController } from "./model-call-limits"
import { AiModelCallRecorder } from "./model-call-recorder"
import { enqueueAiModelCallRecovery } from "./recovery-queue"

/** One accounting boundary shared by all model protocols in a bound execution. */
export class ModelExecutionSession {
  private binding?: ModelExecutionAttempt
  private recorder?: Promise<AiModelCallRecorder>

  constructor(
    private readonly runtime: SixbHostContext & { runtimeAuthorization: RuntimeAuthorization },
    private readonly execution: ExecutionContext
  ) {}

  bind(input: ModelExecutionAttempt): void {
    if (this.binding) throw new Error("[SixbModels] Execution attempt is already bound.")
    this.binding = { ...input }
  }

  signal(signal?: AbortSignal): AbortSignal {
    const binding = this.requireBinding()
    return signal ? AbortSignal.any([binding.signal, signal]) : binding.signal
  }

  async admitEmbeddingCall(admit: () => Promise<void>): Promise<void> {
    const admission = this.requireBinding().embeddingAdmission
    if (admission) await admission(admit)
    else await admit()
  }

  accounting(): Promise<AiModelCallRecorder> {
    this.requireBinding()
    this.recorder ??= this.createRecorder()
    return this.recorder
  }

  private requireBinding(): ModelExecutionAttempt {
    if (!this.binding) {
      throw new Error(
        "[SixbModels] Model calls require a bound request or worker execution attempt."
      )
    }
    return this.binding
  }

  private async createRecorder(): Promise<AiModelCallRecorder> {
    const runtime = this.runtime
    const execution = this.execution
    const { attempt } = this.requireBinding()
    const storage = {
      ...requireAccountingCapabilities(runtime.storage),
      transaction: runtime.storage.transaction.bind(runtime.storage),
    }
    const { requesterGroupIds } = await ensureExecutionRecord(
      runtime.storage.executions,
      executionRecordInputFromRuntime({
        execution,
        runtimeAuthorization: runtime.runtimeAuthorization,
      })
    )
    return new AiModelCallRecorder({
      storage,
      projectId: runtime.projectId,
      executionId: execution.id,
      attempt,
      requesterGroupIds,
      limits: createAiModelCallLimitController({
        storage,
        projectId: runtime.projectId,
        requestedBy: execution.requestedBy,
        requesterGroupIds,
      }),
      recoverAiModelCall: (input) => enqueueAiModelCallRecovery(runtime.queues.agents, input),
    })
  }
}
