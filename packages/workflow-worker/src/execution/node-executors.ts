import { actionNodeExecutor } from "../nodes/action-node-executor"
import { interventionNodeExecutor } from "../nodes/intervention-node-executor"
import { stepNodeExecutor } from "../nodes/step-node-executor"
import type { WorkflowNodeExecutorRegistry } from "./node-executor"

export const workflowNodeExecutors = {
  action: actionNodeExecutor,
  intervention: interventionNodeExecutor,
  step: stepNodeExecutor,
} satisfies WorkflowNodeExecutorRegistry
