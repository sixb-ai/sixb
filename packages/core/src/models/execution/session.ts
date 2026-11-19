import type { ExecutionContext, RuntimeAuthorization } from "../../execution"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type { SixbHostContext } from "../../runtime/types"
import type { ExecutionRecord } from "../../storage/executions"
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
    const { accounting } = this.requireBinding()
    this.recorder ??= accounting ? Promise.resolve(accounting) : this.createRecorder()
    return this.recorder
  }

  /**
   * The recorder of the execution attempt that admitted a call, to record how it ended when a
   * later request learns it: a video generation outlives the request that started it.
   */
  async accountingFor(execution: ExecutionRecord, attempt: number): Promise<AiModelCallRecorder> {
    const binding = this.requireBinding()
    if (execution.id === this.execution.id && attempt === binding.attempt) {
      return this.accounting()
    }

    return this.recorderFor(execution, attempt)
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
    const { attempt } = this.requireBinding()
    const record = await ensureExecutionRecord(
      this.runtime.storage.executions,
      executionRecordInputFromRuntime({
        execution: this.execution,
        runtimeAuthorization: this.runtime.runtimeAuthorization,
      })
    )
    return this.recorderFor(record, attempt)
  }

  private recorderFor(execution: ExecutionRecord, attempt: number): AiModelCallRecorder {
    const runtime = this.runtime
    const storage = {
      ...requireAccountingCapabilities(runtime.storage),
      transaction: runtime.storage.transaction.bind(runtime.storage),
    }
    const requesterGroupIds = execution.requesterGroupIds
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
