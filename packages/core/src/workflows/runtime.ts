import type { WorkflowDefinition } from "./types"

/**
 * Typed entry point for workflow definitions and runs, exposed as
 * `sixb.workflows`.
 *
 * Owns the registered workflow definitions and implements lookup directly,
 * then delegates run requests to {@link requestWorkflowRun}.
 */
export class WorkflowsRuntime {
  private readonly workflowsById: ReadonlyMap<string, WorkflowDefinition>

  constructor(workflows: readonly WorkflowDefinition[]) {
    this.workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]))
  }

  /** All registered workflow definitions. */
  list(): readonly WorkflowDefinition[] {
    return [...this.workflowsById.values()]
  }

  /** Look up a registered workflow definition by id. */
  getById(workflowId: string): WorkflowDefinition | null {
    return this.workflowsById.get(workflowId) ?? null
  }
}

export function createWorkflowsRuntime(workflows: readonly WorkflowDefinition[]): WorkflowsRuntime {
  return new WorkflowsRuntime(workflows)
}
