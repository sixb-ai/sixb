import { isDeepStrictEqual } from "node:util"
import type { WorkflowDefinition, WorkflowRunSource } from "@sixb/core"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type {
  SixbFailure,
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunExecution,
  WorkflowRunFailureCode,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import type { WorkflowNodeLifecycleContext, WorkflowRunObserver } from "./types"

export const noopWorkflowRunObserver: WorkflowRunObserver = {
  onRunStarted: async () => undefined,
  onNodeStarted: async () => undefined,
  onRunWaiting: async () => undefined,
  onNodeWaiting: async () => undefined,
  onInterventionRequested: async () => undefined,
  onNodeFinished: async () => undefined,
  onRunFinished: async () => undefined,
}

export class WorkflowRunRecorder {
  private readonly nodeRuns: WorkflowNodeRunRecord[]
  private activeNodeRunId: string | null = null
  private recoveredNodeConsumed = false
  private started: boolean
  private finished = false

  constructor(
    private readonly dependencies: {
      readonly projectId: string
      readonly workflow: WorkflowDefinition
      readonly runId: string
      readonly workflowRuns: WorkflowRunStorage
      readonly observer: WorkflowRunObserver
      readonly initialCompletedNodes?: readonly WorkflowNodeRunRecord[]
      readonly initialRunningNode?: WorkflowNodeRunRecord
      readonly alreadyStarted?: boolean
      readonly execution?: WorkflowRunExecution
    }
  ) {
    this.nodeRuns = [...(dependencies.initialCompletedNodes ?? [])]
    this.started = dependencies.alreadyStarted ?? false
  }

  get hasStarted(): boolean {
    return this.started
  }

  get hasFinished(): boolean {
    return this.finished
  }

  get activeNodeId(): string | null {
    return this.activeNodeRunId
  }

  get completedNodes(): readonly WorkflowNodeRunRecord[] {
    return [...this.nodeRuns]
  }

  async startRun(params: {
    readonly input: WorkflowIOSnapshot
    readonly source?: WorkflowRunSource
  }): Promise<WorkflowRunRecord> {
    const run = await this.dependencies.workflowRuns.start({
      projectId: this.dependencies.projectId,
      id: this.dependencies.runId,
      workflowId: this.dependencies.workflow.id,
      input: params.input,
      source: params.source,
      execution: this.dependencies.execution,
    })
    this.started = true
    await this.notify(() => this.dependencies.observer.onRunStarted(run))
    return run
  }

  async startNode(params: {
    readonly nodeIndex: number
    readonly nodeType: WorkflowNodeRunRecord["nodeType"]
    readonly nodeId: string
    readonly nodeKey: string
    readonly input: WorkflowIOSnapshot
  }): Promise<WorkflowNodeRunRecord> {
    const nodeRunId = this.nodeRunIdFor(params.nodeIndex)
    const recovered = this.dependencies.initialRunningNode
    if (recovered && !this.recoveredNodeConsumed) {
      assertRecoveredNodeMatches({
        recovered,
        expected: {
          id: nodeRunId,
          workflowRunId: this.dependencies.runId,
          workflowId: this.dependencies.workflow.id,
          nodeIndex: params.nodeIndex,
          nodeType: params.nodeType,
          nodeId: params.nodeId,
          nodeKey: params.nodeKey,
          input: params.input,
        },
      })
      this.recoveredNodeConsumed = true
      this.activeNodeRunId = recovered.id
      return recovered
    }
    const node = await this.dependencies.workflowRuns.nodes.start({
      projectId: this.dependencies.projectId,
      id: nodeRunId,
      workflowRunId: this.dependencies.runId,
      workflowId: this.dependencies.workflow.id,
      nodeIndex: params.nodeIndex,
      nodeType: params.nodeType,
      nodeId: params.nodeId,
      nodeKey: params.nodeKey,
      input: params.input,
      executionToken: this.dependencies.execution?.token,
    })
    this.activeNodeRunId = node.id
    await this.notify(() => this.dependencies.observer.onNodeStarted(node, this.nodeContext()))
    return node
  }

  async waitActiveNode(params: {
    readonly nodeRunId: string
    readonly waitingAt?: Date
  }): Promise<WorkflowNodeRunRecord> {
    const waitingAt = params.waitingAt ?? new Date()
    const node = await this.dependencies.workflowRuns.nodes.wait({
      projectId: this.dependencies.projectId,
      id: params.nodeRunId,
      waitingAt,
      executionToken: this.dependencies.execution?.token,
    })
    this.nodeRuns.push(node)
    if (this.activeNodeRunId === node.id) {
      this.activeNodeRunId = null
    }
    await this.notify(async () => {
      await this.dependencies.observer.onNodeWaiting?.(node, {
        ...this.nodeContext(),
        waitingAt,
      })
    })
    return node
  }

  async recordParkedNode(params: {
    readonly node: WorkflowNodeRunRecord
    readonly run: WorkflowRunRecord
    readonly waitingAt: Date
  }): Promise<void> {
    this.nodeRuns.push(params.node)
    if (this.activeNodeRunId === params.node.id) this.activeNodeRunId = null
    await this.notify(async () => {
      await this.dependencies.observer.onNodeWaiting?.(params.node, {
        ...this.nodeContext(),
        waitingAt: params.waitingAt,
      })
    })
    await this.notify(async () => {
      await this.dependencies.observer.onRunWaiting?.(params.run, {
        waitingAt: params.waitingAt,
      })
    })
  }

  async finishNodeSucceeded(params: {
    readonly nodeRunId: string
    readonly output?: WorkflowIOSnapshot
  }): Promise<WorkflowNodeRunRecord> {
    const node = await this.dependencies.workflowRuns.nodes.finish({
      projectId: this.dependencies.projectId,
      id: params.nodeRunId,
      status: "succeeded",
      output: params.output,
      executionToken: this.dependencies.execution?.token,
    })
    this.nodeRuns.push(node)
    this.activeNodeRunId = null
    await this.notify(() => this.dependencies.observer.onNodeFinished(node, this.nodeContext()))
    return node
  }

  async finishActiveNodeAfterError(params: {
    readonly status: "failed" | "cancelled"
    readonly error: SixbFailure<WorkflowRunFailureCode>
  }): Promise<void> {
    if (!this.activeNodeRunId) {
      return
    }

    const node = await this.dependencies.workflowRuns.nodes
      .finish({
        projectId: this.dependencies.projectId,
        id: this.activeNodeRunId,
        status: params.status,
        error: params.error,
        executionToken: this.dependencies.execution?.token,
      })
      .catch(() => null)

    if (!node) {
      return
    }

    this.nodeRuns.push(node)
    this.activeNodeRunId = null
    await this.notify(() => this.dependencies.observer.onNodeFinished(node, this.nodeContext()))
  }

  async finishRunSucceeded(output: WorkflowIOSnapshot): Promise<WorkflowRunRecord> {
    const run = await this.dependencies.workflowRuns.finish({
      projectId: this.dependencies.projectId,
      id: this.dependencies.runId,
      status: "succeeded",
      output,
      executionToken: this.dependencies.execution?.token,
    })
    this.finished = true
    await this.notify(() => this.dependencies.observer.onRunFinished(run))
    return run
  }

  async waitRun(params: { readonly waitingAt?: Date } = {}): Promise<WorkflowRunRecord> {
    const waitingAt = params.waitingAt ?? new Date()
    const run = await this.dependencies.workflowRuns.wait({
      projectId: this.dependencies.projectId,
      id: this.dependencies.runId,
      waitingAt,
      executionToken: this.dependencies.execution?.token,
    })
    await this.notify(async () => {
      await this.dependencies.observer.onRunWaiting?.(run, { waitingAt })
    })
    return run
  }

  async recordInterventionRequested(intervention: WorkflowInterventionRecord): Promise<void> {
    await this.notify(async () => {
      await this.dependencies.observer.onInterventionRequested?.(intervention)
    })
  }

  async finishRunAfterError(params: {
    readonly status: "failed" | "cancelled"
    readonly error: SixbFailure<WorkflowRunFailureCode>
    readonly onTransition?: (run: WorkflowRunRecord) => void
  }): Promise<WorkflowRunRecord> {
    const run = await this.dependencies.workflowRuns.finish({
      projectId: this.dependencies.projectId,
      id: this.dependencies.runId,
      status: params.status,
      error: params.error,
      executionToken: this.dependencies.execution?.token,
    })
    this.finished = true
    params.onTransition?.(run)
    await this.notify(() => this.dependencies.observer.onRunFinished(run))
    return run
  }

  nodeRunIdFor(nodeIndex: number): string {
    return `${this.dependencies.runId}:node:${nodeIndex}`
  }

  private nodeContext(): WorkflowNodeLifecycleContext {
    return {
      totalNodes: this.dependencies.workflow.nodes.length,
    }
  }

  private async notify(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (error) {
      // Lost event batches are reported by the observer itself. Anything reaching here is a broken
      // invariant in a custom observer, not a delivery failure.
      console.error("[SixbWorkflowWorker] Workflow lifecycle observer failed:", error)
    }
  }
}

function assertRecoveredNodeMatches(input: {
  readonly recovered: WorkflowNodeRunRecord
  readonly expected: Pick<
    WorkflowNodeRunRecord,
    | "id"
    | "workflowRunId"
    | "workflowId"
    | "nodeIndex"
    | "nodeType"
    | "nodeId"
    | "nodeKey"
    | "input"
  >
}): void {
  const { recovered, expected } = input
  if (
    recovered.status !== "running" ||
    recovered.id !== expected.id ||
    recovered.workflowRunId !== expected.workflowRunId ||
    recovered.workflowId !== expected.workflowId ||
    recovered.nodeIndex !== expected.nodeIndex ||
    recovered.nodeType !== expected.nodeType ||
    recovered.nodeId !== expected.nodeId ||
    recovered.nodeKey !== expected.nodeKey ||
    !isDeepStrictEqual(recovered.input, expected.input)
  ) {
    throw new Error(
      `[SixbWorkflowWorker] Running workflow node '${recovered.id}' does not match its recovered definition and input.`
    )
  }
}
