import { actionNodeExecutor } from "../nodes/action-node-executor"
import { agentNodeExecutor } from "../nodes/agent-node-executor"
import { interventionNodeExecutor } from "../nodes/intervention-node-executor"
import { stepNodeExecutor } from "../nodes/step-node-executor"
import type { WorkflowNodeExecutorRegistry } from "./node-executor"

export const workflowNodeExecutors = {
  action: actionNodeExecutor,
  agent: agentNodeExecutor,
  intervention: interventionNodeExecutor,
  step: stepNodeExecutor,
} satisfies WorkflowNodeExecutorRegistry
