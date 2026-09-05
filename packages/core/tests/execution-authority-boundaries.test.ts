import { describe, expect, test } from "bun:test"
import { requestAction } from "../src/actions/request"
import { requestAgentRun, retryAgentRun } from "../src/agents/request"
import type { AgentDefinition } from "../src/agents/types"
import { type AuthorizationContext, emptyGrantIndex } from "../src/authorization"
import { createTestingScope } from "../src/execution/scopes"
import { requestPipelineRun } from "../src/pipelines/request"
import type { PipelineDefinition } from "../src/pipelines/types"
import type { SixbRuntimeContext } from "../src/runtime/types"
import type { SecurityDefinitionCatalog } from "../src/security"
import type { AgentRunRecord } from "../src/storage/agents"
import { requestSyncRun } from "../src/syncs/request"
import type { SyncDefinition } from "../src/syncs/types"
import { requestWorkflowRun } from "../src/workflows/request"
import type { WorkflowDefinition } from "../src/workflows/types"

describe("execution authority boundaries", () => {
  test("run requests reject another same-principal execution before dependencies", async () => {
    const context: AuthorizationContext = {
      principal: { type: "user", id: "same-principal" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    }
    const authorityScope = createTestingScope({
      projectId: "project-1",
      executionId: "execution-authorized",
      context,
    })
    const foreignExecution = createTestingScope({
      projectId: "project-1",
      executionId: "execution-foreign",
      context,
    }).execution
    const runtime = {
      projectId: "project-1",
      runtimeAuthorization: authorityScope.authorization,
    } as SixbRuntimeContext
    const expected = "authority is bound to different execution provenance"

    await expect(
      requestAction(runtime, foreignExecution, { actionId: "action-1" })
    ).rejects.toThrow(expected)
    await expect(
      requestAgentRun(
        runtime,
        foreignExecution,
        {} as SecurityDefinitionCatalog,
        { id: "agent-1" } as AgentDefinition,
        { agentId: "agent-1", text: "hello" }
      )
    ).rejects.toThrow(expected)
    await expect(
      retryAgentRun(
        runtime,
        foreignExecution,
        {} as SecurityDefinitionCatalog,
        { id: "agent-1" } as AgentDefinition,
        { id: "run-1" } as AgentRunRecord
      )
    ).rejects.toThrow(expected)
    await expect(
      requestPipelineRun(runtime, foreignExecution, { id: "pipeline-1" } as PipelineDefinition)
    ).rejects.toThrow(expected)
    await expect(
      requestSyncRun(runtime, foreignExecution, { id: "sync-1" } as SyncDefinition)
    ).rejects.toThrow(expected)
    await expect(
      requestWorkflowRun(runtime, foreignExecution, { id: "workflow-1" } as WorkflowDefinition)
    ).rejects.toThrow(expected)
  })
})
