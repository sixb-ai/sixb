import type {
  WorkflowDefinition,
  WorkflowIOSnapshot,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@pario/core"
import type { WorkflowNodeLifecycleContext, WorkflowRunObserver } from "./types"

export const noopWorkflowRunObserver: WorkflowRunObserver = {
  onRunStarted: async () => undefined,
  onNodeStarted: async () => undefined,
  onNodeFinished: async () => undefined,
  onRunFinished: async () => undefined,
}

export class WorkflowRunRecorder {
  private readonly nodeRuns: WorkflowNodeRunRecord[] = []
  private activeNodeRunId: string | null = null
  private started = false
  private finished = false

  constructor(
    private readonly dependencies: {
      readonly projectId: string
      readonly workflow: WorkflowDefinition
      readonly runId: string
      readonly workflowRuns: WorkflowRunStorage
      readonly observer: WorkflowRunObserver
    }
  ) {}

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

  async startRun(params: { readonly input: WorkflowIOSnapshot }): Promise<WorkflowRunRecord> {
    const run = await this.dependencies.workflowRuns.start({
      projectId: this.dependencies.projectId,
      id: this.dependencies.runId,
      workflowId: this.dependencies.workflow.id,
      input: params.input,
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
    })
    this.activeNodeRunId = node.id
    await this.notify(() => this.dependencies.observer.onNodeStarted(node, this.nodeContext()))
    return node
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
    })
    this.nodeRuns.push(node)
    this.activeNodeRunId = null
    await this.notify(() => this.dependencies.observer.onNodeFinished(node, this.nodeContext()))
    return node
  }

  async finishActiveNodeAfterError(params: {
    readonly status: "failed" | "cancelled"
    readonly error: string
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
      })
      .catch(() => null)

    if (!node) {
      return
    }

    this.nodeRuns.push(node)
    this.activeNodeRunId = null
    await this.notify(() => this.dependencies.observer.onNodeFinished(node, this.nodeContext()))
  }

  async finishRunSucceeded(): Promise<WorkflowRunRecord> {
    const run = await this.dependencies.workflowRuns.finish({
      projectId: this.dependencies.projectId,
      id: this.dependencies.runId,
      status: "succeeded",
    })
    this.finished = true
    await this.notify(() => this.dependencies.observer.onRunFinished(run))
    return run
  }

  async finishRunAfterError(params: {
    readonly status: "failed" | "cancelled"
    readonly error: string
  }): Promise<WorkflowRunRecord> {
    const run = await this.dependencies.workflowRuns.finish({
      projectId: this.dependencies.projectId,
      id: this.dependencies.runId,
      status: params.status,
      error: params.error,
    })
    this.finished = true
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
      console.error("[ParioWorkflowWorker] Failed to emit workflow lifecycle event:", error)
    }
  }
}
