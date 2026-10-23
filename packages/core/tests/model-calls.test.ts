import { describe, expect, test } from "bun:test"
import { type AuthorizationContext, InMemoryStorage } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import type { FileRef } from "../src/blob-storage/types"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import { createModelCallsRuntime, type ModelCallRunVisibility } from "../src/models/calls"
import { createTestAgentExecution } from "../src/testing/agent-execution"
import { createTestWorkflowExecution } from "../src/testing/workflow-execution"

const projectId = "model-calls"
const alice = { type: "user", id: "alice" } as const
const bob = { type: "user", id: "bob" } as const
const file: FileRef = {
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 3,
  mediaType: "image/png",
}

function principal(user: typeof alice | typeof bob): AuthorizationContext {
  return { principal: user, groupIds: [], roleIds: [], grants: emptyGrantIndex() }
}

/** Runs each kind of execution can be: the call ID names the execution that made it. */
async function seed() {
  const storage = new InMemoryStorage()
  const record = (callId: string, executionId: string) =>
    storage.aiUsage.recordModelCallFiles({ projectId, callId, executionId, files: [file] })

  await storage.auth.users.create({ projectId, id: alice.id, email: "alice@example.test" })
  await storage.executions.create({
    projectId,
    id: "exec_request",
    requestedBy: alice,
    executor: { type: "request", requestId: "request" },
    source: { type: "http", requestId: "request" },
    correlationId: "request",
    authorizationRef: { type: "principal", principal: alice },
  })
  await record("call_request", "exec_request")

  for (const kind of ["action", "workflow"] as const) {
    const primitive = { kind, id: "summarize", runId: `${kind}_run` }
    await storage.executions.create({
      projectId,
      id: `exec_${kind}`,
      executor: { type: "primitive", kind, runId: primitive.runId },
      source: { type: "event", eventId: kind },
      correlationId: kind,
      authorizationRef: { type: "trustedPrimitive", primitive },
    })
    await record(`call_${kind}`, `exec_${kind}`)
  }

  // A thread's run and the subagent it spawned.
  await storage.agents.threads.create({ id: "thread", projectId, ownerPrincipal: alice })
  const parentExecution = await createTestAgentExecution(storage, {
    projectId,
    runId: "parent",
    executionId: "exec_parent",
  })
  await storage.agents.runs.create({
    id: "parent",
    projectId,
    executionId: parentExecution,
    threadId: "thread",
    triggerMessageId: "message",
    spec: { model: { provider: "test", modelId: "large" } },
  })
  await storage.agents.runs.start({
    id: "parent",
    projectId,
    execution: { token: "parent", queueLeaseExpiresAt: new Date("2100-01-01T00:00:00Z") },
  })
  const childExecution = await createTestAgentExecution(storage, {
    projectId,
    actorId: "child",
    runId: "child",
    executionId: "exec_child",
    sourceExecutionId: parentExecution,
    authority: "inherited",
  })
  await storage.agents.runs.createSubagent({
    id: "child",
    projectId,
    executionId: childExecution,
    parentRunId: "parent",
    parentExecutionToken: "parent",
    spawnKey: "research",
    spec: {
      model: { provider: "test", modelId: "small" },
      task: "Research",
      toolNames: [],
      maxSteps: 25,
    },
    maxActiveChildren: 4,
  })
  await record("call_thread", parentExecution)
  await record("call_subagent", childExecution)

  // A workflow's agent step.
  const workflowExecution = await createTestWorkflowExecution(storage.executions, {
    projectId,
    workflowId: "review",
    runId: "review_run",
  })
  await storage.workflowRuns.queue({
    projectId,
    id: "review_run",
    workflowId: "review",
    executionId: workflowExecution,
    input: {},
  })
  await storage.workflowRuns.start({ projectId, id: "review_run" })
  await storage.workflowRuns.nodes.start({
    projectId,
    id: "review_run:node:0",
    workflowId: "review",
    workflowRunId: "review_run",
    nodeIndex: 0,
    nodeType: "agent",
    nodeId: "draft",
    nodeKey: "draft",
    input: {},
  })
  const stepExecution = await createTestAgentExecution(storage, {
    projectId,
    actorId: "draft",
    runId: "review_run:node:0",
    sourceExecutionId: workflowExecution,
  })
  await record("call_step", stepExecution)

  return storage
}

/** The runs this caller may see, as the run lookups would answer. */
function visibility(visible: readonly string[]): ModelCallRunVisibility & { asked: string[] } {
  const asked: string[] = []
  const check = (kind: string) => async (runId: string) => {
    asked.push(`${kind}:${runId}`)
    return visible.includes(`${kind}:${runId}`)
  }
  return {
    asked,
    canViewActionRun: check("action"),
    canViewWorkflowRun: check("workflow"),
    canViewAgentRun: check("agent"),
  }
}

describe("model call files", () => {
  // Removal proof: return true from canRead for request executors; bob reads alice's file.
  test("a request's files are its requester's", async () => {
    const storage = await seed()
    const read = (context: AuthorizationContext) =>
      createModelCallsRuntime(
        {
          projectId,
          storage,
          runtimeAuthorization: createTestingScope({ projectId, context }).authorization,
        },
        visibility([])
      ).files("call_request")

    expect(await read(principal(alice))).toEqual({
      callId: "call_request",
      files: [file],
      recordedAt: expect.any(Date),
    })
    expect(await read(principal(bob))).toBeNull()
  })

  // Removal proof: return true for primitive or agent executors; a hidden run's files are returned.
  test("runs follow the visibility of the run, thread or workflow that made them", async () => {
    const storage = await seed()
    const runs = visibility(["action:action_run", "agent:parent", "workflow:review_run"])
    const calls = createModelCallsRuntime(
      {
        projectId,
        storage,
        runtimeAuthorization: createTestingScope({ projectId, context: principal(bob) })
          .authorization,
      },
      runs
    )

    for (const callId of ["call_action", "call_thread", "call_subagent", "call_step"]) {
      expect((await calls.files(callId))?.files).toEqual([file])
    }
    expect(await calls.files("call_workflow")).toBeNull()

    const hidden = createModelCallsRuntime(
      {
        projectId,
        storage,
        runtimeAuthorization: createTestingScope({ projectId, context: principal(bob) })
          .authorization,
      },
      visibility([])
    )
    for (const callId of ["call_action", "call_thread", "call_subagent", "call_step"]) {
      expect(await hidden.files(callId)).toBeNull()
    }
    // A subagent's files follow its parent's thread; a workflow step's, its workflow run.
    expect(runs.asked).toEqual([
      "action:action_run",
      "agent:parent",
      "agent:parent",
      "workflow:review_run",
      "workflow:workflow_run",
    ])
  })

  test("an unrestricted caller reads every call; a shared link and unknown calls read none", async () => {
    const storage = await seed()
    const unrestricted = createModelCallsRuntime(
      { projectId, storage, runtimeAuthorization: createTestingScope({ projectId }).authorization },
      visibility([])
    )
    expect((await unrestricted.files("call_thread"))?.files).toEqual([file])
    expect(await unrestricted.files("call_missing")).toBeNull()

    const shared = createModelCallsRuntime(
      {
        projectId,
        storage,
        runtimeAuthorization: createDelegatedRequestScope({
          projectId,
          requestId: "shared",
          correlationId: "shared",
          objectRead: {
            selection: { kind: "selected", roots: [] },
            limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
          },
        }).authorization,
      },
      visibility(["agent:parent"])
    )
    expect(await shared.files("call_thread")).toBeNull()
    await expect(unrestricted.files(" ")).rejects.toThrow("nonblank")
  })
})
