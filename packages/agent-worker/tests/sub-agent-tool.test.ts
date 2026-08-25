import { describe, expect, test } from "bun:test"
import { InMemoryBroker, resolveAuthorizationContext } from "@sixb/core"
import { agentRunQueueJobId, publishAgentRunCancel } from "@sixb/core/internal/agents"
import { createTestSixb } from "@sixb/core/testing"
import { MockLanguageModelV4 } from "ai/test"
import { AgentWorker } from "../src"
import { resolveSubAgentTargets } from "../src/sub-agent-tool"
import { waitFor } from "./helpers"
import {
  API_BASE_URL,
  answer,
  buildHost,
  CountingSandboxFactory,
  delegatingModel,
  PROJECT_ID,
  REQUESTER,
  recordingQueues,
  requestMainTurn,
  runWorkerUntilIdle,
  stream,
} from "./sub-agent-harness"

describe("sub_agent", () => {
  test("runs the child in the parent's slot, never through the agent queue", async () => {
    const enqueued: string[] = []
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
      queues: recordingQueues(enqueued),
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    await runWorkerUntilIdle(sixb, requested.run.id)

    const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
    const child = runs?.runs.find((run) => run.agentId === "researcher")
    expect(child?.status).toBe("succeeded")

    // The delegating run is queued normally; the child never is. A child that reached the queue
    // would be claimed by a worker and either started a second time or reclaimed out from under
    // the in-process turn that is already running it.
    expect(enqueued).toContain(agentRunQueueJobId(requested.run.id))
    expect(enqueued).not.toContain(agentRunQueueJobId(child?.id ?? ""))
  })

  test("keeps child threads owned by the agent even though the parent runs as the user", async () => {
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    await runWorkerUntilIdle(sixb, requested.run.id)

    const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
    const child = runs?.runs.find((run) => run.agentId === "researcher")
    const childThread = await sixb.storage.agents?.threads.getById({
      projectId: PROJECT_ID,
      id: child?.threadId ?? "",
    })

    // The delegating turn now runs *as the requester*, so `context.agentPrincipal` is the human.
    // Owning child threads by that principal would surface every delegated conversation in the
    // user's own thread list.
    expect(childThread?.ownerPrincipal).toEqual({ type: "serviceAccount", id: "svc_agent_main" })

    // Authorship is the agent's even though the run's *authority* is the human.
    const parentMessages = await sixb.storage.agents?.messages.list({
      projectId: PROJECT_ID,
      threadId: requested.run.threadId,
      roles: ["assistant"],
      order: "asc",
    })
    expect(parentMessages?.messages[0]?.authorPrincipal).toEqual({
      type: "serviceAccount",
      id: "svc_agent_main",
    })

    const visible = await createTestSixb(sixb, {
      authorization: resolveAuthorizationContext({
        principal: REQUESTER,
        groupIds: ["agent-users"],
        roles: sixb.definitions.security.listResolvedRoles(),
      }),
    }).agents.threads.list({})
    expect(visible.threads.map((thread) => thread.agentId)).toEqual(["main"])
  })

  test("links the child execution to the delegating one and bills it separately", async () => {
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    await runWorkerUntilIdle(sixb, requested.run.id)

    const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
    const parent = runs?.runs.find((run) => run.agentId === "main")
    const child = runs?.runs.find((run) => run.agentId === "researcher")
    const childExecution = await sixb.storage.executions.getById({
      projectId: PROJECT_ID,
      id: child?.executionId ?? "",
    })

    expect(childExecution?.source).toEqual({
      type: "execution",
      executionId: parent?.executionId ?? "",
    })
    // Usage follows the execution tree rather than being copied onto the parent.
    const childUsage = await sixb.storage.aiUsage?.summarizeExecution({
      projectId: PROJECT_ID,
      executionId: child?.executionId ?? "",
    })
    expect(childUsage?.modelCallCount).toBeGreaterThan(0)
  })

  test("offers only agents the requester could run directly, and never itself", () => {
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({ modelId: "specialist-model" }),
      sandboxes: new CountingSandboxFactory(),
    })
    const roles = sixb.definitions.security.listResolvedRoles()

    const permitted = resolveSubAgentTargets({
      host: sixb,
      agentId: "main",
      requesterAuthorization: resolveAuthorizationContext({
        principal: REQUESTER,
        groupIds: ["agent-users"],
        roles,
      }),
    })
    // `main` is in the requester's grants via `every.agent()`, yet must not be offered: withholding
    // it is what keeps delegation one level deep.
    expect(permitted.map((agent) => agent.id)).toEqual(["researcher"])

    const ungranted = resolveSubAgentTargets({
      host: sixb,
      agentId: "main",
      requesterAuthorization: resolveAuthorizationContext({
        principal: REQUESTER,
        groupIds: [],
        roles,
      }),
    })
    expect(ungranted).toEqual([])

    // No requester at all denies outright rather than falling through to "no constraints".
    expect(
      resolveSubAgentTargets({ host: sixb, agentId: "main", requesterAuthorization: null })
    ).toEqual([])
  })

  test("cancels the child and releases its thread when the delegating turn is cancelled", async () => {
    const broker = new InMemoryBroker()
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      // Hangs until aborted, so the child is still running when the cancel lands.
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            )
          }),
      }),
      sandboxes: new CountingSandboxFactory(),
      broker,
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    const worker = new AgentWorker(sixb, {
      apiBaseUrl: API_BASE_URL,
      idlePollMs: 5,
      skillsDir: false,
    })
    await worker.start()
    try {
      const child = await waitFor(async () => {
        const runs = await sixb.storage.agents?.runs.list({ projectId: PROJECT_ID })
        return runs?.runs.find((run) => run.agentId === "researcher" && run.status === "running")
      })
      await publishAgentRunCancel(broker, { projectId: PROJECT_ID, runId: requested.run.id })

      const finished = await waitFor(async () => {
        const run = await sixb.storage.agents?.runs.getById({ projectId: PROJECT_ID, id: child.id })
        return run && run.status !== "running" ? run : undefined
      })
      // A cancel is not a failure: the child stopped because its parent did.
      //
      // This is a characterization test, not a guard on one line: the finalize comes from
      // `runAgentTurn`'s own cancel path, and it still passes if the tool's catch block is removed,
      // if its recorded status is hard-coded, or if `parentSignal` is dropped from the child's
      // abort sources (the AI SDK forwards its own signal into `execute`). It is here because the
      // end-to-end outcome matters and nothing else covers it — an in-process child has no queue
      // job, so a leak on this path would never be reclaimed.
      expect(finished.status).toBe("cancelled")

      // The child must not be left holding its thread. Nothing else reclaims an in-process child,
      // so a thread pinned here would stay pinned for the life of the project.
      const thread = await sixb.storage.agents?.threads.getById({
        projectId: PROJECT_ID,
        id: child.threadId,
      })
      expect(thread?.activeRunId).toBeNull()
    } finally {
      await worker.stop()
    }
  })
})
