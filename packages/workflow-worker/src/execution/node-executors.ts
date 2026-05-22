import { actionNodeExecutor } from "../nodes/action-node-executor"
import { stepNodeExecutor } from "../nodes/step-node-executor"
import type { WorkflowNodeExecutorRegistry } from "./node-executor"

export const workflowNodeExecutors = {
  action: actionNodeExecutor,
  step: stepNodeExecutor,
} satisfies WorkflowNodeExecutorRegistry
