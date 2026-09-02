/** Stable internal actor id for one workflow Agent step. */
export function workflowAgentStepActorId(workflowId: string, stepId: string): string {
  return `workflow:${encodeURIComponent(workflowId)}:step:${encodeURIComponent(stepId)}`
}
