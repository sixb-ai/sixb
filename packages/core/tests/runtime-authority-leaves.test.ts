import { describe, expect, test } from "bun:test"
import { createActionsRuntime } from "../src/actions/execution"
import { requestAction, waitForActionRun } from "../src/actions/request"
import { createAgentsRuntime } from "../src/agents/execution"
import { AuthorizationError, assertAuthorized, emptyGrantIndex } from "../src/authorization"
import { createEventsRuntime } from "../src/events/execution"
import type { StoredDomainEvent } from "../src/events/types"
import type { ExecutionContext } from "../src/execution"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import { createRuntimeAuthorizationCapability } from "../src/execution/types"
import { listObjects } from "../src/objects/service/list-service"
import { createPipelinesRuntime } from "../src/pipelines/execution"
import { createProjectionsRuntime } from "../src/projections/execution"
import type { ProjectionDefinitionCatalog } from "../src/projections/registry"
import { createRulesRuntime } from "../src/rules/execution"
import type { SixbRuntimeContext } from "../src/runtime/types"
import { createSchedulesRuntime } from "../src/schedules/execution"
import { createSyncsRuntime } from "../src/syncs/execution"
import { createWorkflowsRuntime } from "../src/workflows/execution"

const deniedAuthorities = [
  { name: "missing authority", value: undefined },
  { name: "forged authority", value: {} },
  { name: "unregistered capability", value: createRuntimeAuthorizationCapability() },
  {
    name: "delegated authority",
    value: createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "request-delegated",
      correlationId: "correlation-delegated",
      access: { grants: [] },
      delegation: { kind: "share", id: "share-1" },
    }).authorization,
  },
  {
    name: "wrong-project unrestricted authority",
    value: createTestingScope({ projectId: "another-project" }).authorization,
  },
  {
    name: "wrong-project principal authority",
    value: createTestingScope({
      projectId: "another-project",
      context: {
        principal: { type: "user", id: "cross-project" },
        groupIds: [],
        roleIds: [],
        grants: emptyGrantIndex(),
      },
    }).authorization,
  },
  {
    name: "wrong-project delegated authority",
    value: createDelegatedRequestScope({
      projectId: "another-project",
      requestId: "request-cross-project-delegated",
      correlationId: "correlation-cross-project-delegated",
      access: { grants: [] },
      delegation: { kind: "share", id: "cross-project-share" },
    }).authorization,
  },
] as const

const execution = {} as ExecutionContext
const event = {} as StoredDomainEvent

function runtimeWith(
  runtimeAuthorization: unknown,
  dependencies: Readonly<Record<string, unknown>>
): SixbRuntimeContext {
  return {
    projectId: "project-1",
    runtimeAuthorization,
    ...dependencies,
  } as unknown as SixbRuntimeContext
}

describe("protected runtime leaves", () => {
  for (const candidate of deniedAuthorities) {
    test(`events fail closed for ${candidate.name} before reading the provider`, async () => {
      const calls = { append: 0, emit: 0, latestCursor: 0, read: 0, subscribe: 0 }
      const runtime = runtimeWith(candidate.value, {
        events: {
          append: async () => {
            calls.append += 1
            return [event]
          },
          emit: async () => {
            calls.emit += 1
          },
          latestCursor: async () => {
            calls.latestCursor += 1
            return "cursor-1"
          },
          read: async () => {
            calls.read += 1
            return [event]
          },
          subscribe: async () => {
            calls.subscribe += 1
            return () => {}
          },
        },
      })
      const events = createEventsRuntime(runtime)

      expect(events.canRead(event)).toBe(false)
      expect(() => events.append({ events: [] })).toThrow(AuthorizationError)
      expect(() => events.emit({ events: [] }, { source: "test" })).toThrow(AuthorizationError)
      expect(await events.read()).toEqual([])
      expect(await events.latestCursor()).toBeUndefined()
      const unsubscribe = await events.subscribe({}, () => {
        throw new Error("Denied subscriptions must never invoke their handler.")
      })
      unsubscribe()

      expect(calls).toEqual({ append: 0, emit: 0, latestCursor: 0, read: 0, subscribe: 0 })
    })

    test(`action runs fail closed for ${candidate.name} before reading storage`, async () => {
      const calls = { getById: 0, list: 0, subscribe: 0 }
      const runtime = runtimeWith(candidate.value, {
        actionRegistry: {},
        events: {
          subscribe: async () => {
            calls.subscribe += 1
            throw new Error("Denied action-run waits must not subscribe to events.")
          },
        },
        storage: {
          actionRuns: {
            getById: async () => {
              calls.getById += 1
              throw new Error("Denied action-run reads must not reach storage.")
            },
            list: async () => {
              calls.list += 1
              throw new Error("Denied action-run lists must not reach storage.")
            },
          },
        },
      })
      const runs = createActionsRuntime(runtime, execution).runs

      expect(await runs.getById("run-1")).toBeNull()
      expect(await runs.list()).toEqual({ runs: [], hasMore: false, total: 0 })
      await expect(waitForActionRun(runtime, { runId: "run-1", timeoutMs: 1 })).rejects.toThrow()
      expect(calls).toEqual({ getById: 0, list: 0, subscribe: 0 })
    })

    test(`projections fail closed for ${candidate.name} before reading catalogs or storage`, async () => {
      const calls = {
        getById: 0,
        list: 0,
        listLinks: 0,
        listObjects: 0,
        listTelemetry: 0,
        runGetById: 0,
        runList: 0,
        runListLatest: 0,
      }
      const source = {
        getById: () => {
          calls.getById += 1
          return null
        },
        list: () => {
          calls.list += 1
          return []
        },
        listLinks: () => {
          calls.listLinks += 1
          return []
        },
        listObjects: () => {
          calls.listObjects += 1
          return []
        },
        listTelemetry: () => {
          calls.listTelemetry += 1
          return []
        },
      } satisfies ProjectionDefinitionCatalog
      const runtime = runtimeWith(candidate.value, {
        storage: {
          projectionRuns: {
            getById: async () => {
              calls.runGetById += 1
              throw new Error("Denied projection-run reads must not reach storage.")
            },
            list: async () => {
              calls.runList += 1
              throw new Error("Denied projection-run lists must not reach storage.")
            },
            listLatestByProjectionIds: async () => {
              calls.runListLatest += 1
              throw new Error("Denied latest projection-run reads must not reach storage.")
            },
          },
        },
      })
      const projections = createProjectionsRuntime(runtime, source)

      expect(projections.list()).toEqual([])
      expect(projections.listLinks()).toEqual([])
      expect(projections.listObjects()).toEqual([])
      expect(projections.listTelemetry()).toEqual([])
      expect(projections.getById("projection-1")).toBeNull()
      expect(await projections.runs.getById("run-1")).toBeNull()
      expect(await projections.runs.list()).toEqual({ runs: [], hasMore: false, total: 0 })
      expect(await projections.runs.listLatest(["projection-1"])).toEqual({ runs: [] })
      expect(calls).toEqual({
        getById: 0,
        list: 0,
        listLinks: 0,
        listObjects: 0,
        listTelemetry: 0,
        runGetById: 0,
        runList: 0,
        runListLatest: 0,
      })
    })

    test(`schedules fail closed for ${candidate.name} before reading the catalog`, () => {
      const calls = { getById: 0, list: 0 }
      const schedules = createSchedulesRuntime(runtimeWith(candidate.value, {}), {
        getById: () => {
          calls.getById += 1
          return null
        },
        list: () => {
          calls.list += 1
          return []
        },
      })

      expect(schedules.list()).toEqual([])
      expect(schedules.getById("schedule-1")).toBeNull()
      expect(calls).toEqual({ getById: 0, list: 0 })
    })

    test(`rules fail closed for ${candidate.name} before reading catalog or storage`, async () => {
      const calls = { catalogGet: 0, catalogList: 0, statesList: 0 }
      const rules = createRulesRuntime(
        runtimeWith(candidate.value, {
          storage: {
            rules: {
              listActive: async () => {
                calls.statesList += 1
                throw new Error("Denied rule-state reads must not reach storage.")
              },
            },
          },
        }),
        {
          getById: () => {
            calls.catalogGet += 1
            return null
          },
          list: () => {
            calls.catalogList += 1
            return []
          },
        }
      )

      expect(rules.list()).toEqual([])
      expect(rules.getById("rule-1")).toBeNull()
      expect(await rules.states.list()).toEqual({ states: [], hasMore: false, total: 0 })
      expect(calls).toEqual({ catalogGet: 0, catalogList: 0, statesList: 0 })
    })

    test(`agents fail closed for ${candidate.name} before reading catalog or storage`, async () => {
      const calls = { catalogGet: 0, catalogList: 0, runGet: 0, threadGet: 0, threadList: 0 }
      const agents = createAgentsRuntime(
        runtimeWith(candidate.value, {
          storage: {
            agents: {
              runs: {
                getById: async () => {
                  calls.runGet += 1
                  throw new Error("Denied Agent run reads must not reach storage.")
                },
              },
              threads: {
                getById: async () => {
                  calls.threadGet += 1
                  throw new Error("Denied Agent thread reads must not reach storage.")
                },
                list: async () => {
                  calls.threadList += 1
                  throw new Error("Denied Agent thread lists must not reach storage.")
                },
              },
            },
          },
        }),
        execution,
        {
          getById: () => {
            calls.catalogGet += 1
            return null
          },
          list: () => {
            calls.catalogList += 1
            return []
          },
        },
        {} as never
      )

      expect(agents.list()).toEqual([])
      expect(agents.getById("agent-1")).toBeNull()
      expect(await agents.threads.getById("thread-1")).toBeNull()
      expect(await agents.threads.list()).toEqual({ threads: [], hasMore: false, total: 0 })
      expect(await agents.runs.getById("run-1")).toBeNull()
      expect(calls).toEqual({
        catalogGet: 0,
        catalogList: 0,
        runGet: 0,
        threadGet: 0,
        threadList: 0,
      })
    })
  }

  test("delegated authorization errors never describe an unknown principal", () => {
    const delegated = deniedAuthorities[3].value
    const runtime = runtimeWith(delegated, {
      events: {
        append: async () => [],
        emit: async () => {},
      },
    })

    expect(() => createEventsRuntime(runtime).append({ events: [] })).toThrow(
      "Operation 'events.append' is not covered by delegated authority."
    )
    expect(() =>
      assertAuthorized(
        { projectId: "project-1", runtimeAuthorization: delegated },
        { kind: "workflow.run", workflowId: "workflow-1" }
      )
    ).toThrow("Delegated authority does not include required grant 'run:workflow:workflow-1'.")
  })

  test("action requests reject another same-principal execution before reading providers", async () => {
    const calls = { actionCatalog: 0, actionRuns: 0, executions: 0 }
    const context = {
      principal: { type: "user", id: "same-principal" } as const,
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    }
    const authorityScope = createTestingScope({
      projectId: "project-1",
      executionId: "execution-authorized",
      context,
    })
    const runtime = runtimeWith(authorityScope.authorization, {
      actionRegistry: {
        getById: () => {
          calls.actionCatalog += 1
          throw new Error("Mismatched execution must not read the action catalog.")
        },
      },
      storage: {
        actionRuns: {
          getById: async () => {
            calls.actionRuns += 1
            throw new Error("Mismatched execution must not read action runs.")
          },
        },
        executions: {
          getById: async () => {
            calls.executions += 1
            throw new Error("Mismatched execution must not read executions.")
          },
        },
      },
    })
    const foreignExecution = createTestingScope({
      projectId: "project-1",
      executionId: "execution-forged",
      context,
    }).execution

    await expect(
      requestAction(runtime, foreignExecution, { actionId: "secret-action" })
    ).rejects.toThrow("bound to different execution provenance")
    expect(calls).toEqual({ actionCatalog: 0, actionRuns: 0, executions: 0 })
  })

  test("principal list facades overwrite runtime-injected project and authority filters", async () => {
    const principal = { type: "user", id: "authorized-user" } as const
    const grants = {
      ...emptyGrantIndex(),
      "view:object": new Set(["VisibleObject"]),
      "apply:action": new Set(["allowed-action"]),
      "run:sync": new Set(["allowed-sync"]),
      "run:pipeline": new Set(["allowed-pipeline"]),
      "run:workflow": new Set(["allowed-workflow"]),
      "run:agent": new Set(["allowed-agent"]),
    }
    const scope = createTestingScope({
      projectId: "project-1",
      executionId: "execution-list-boundaries",
      context: { principal, groupIds: [], roleIds: [], grants },
    })
    const received: Record<string, unknown> = {}
    const emptyRuns = { runs: [], hasMore: false, total: 0 } as const
    const runtime = runtimeWith(scope.authorization, {
      actionRegistry: {},
      storage: {
        actionRuns: {
          list: async (input: unknown) => {
            received.actions = input
            return emptyRuns
          },
        },
        syncRuns: {
          list: async (input: unknown) => {
            received.syncs = input
            return emptyRuns
          },
        },
        rules: {
          listActive: async (input: unknown) => {
            received.rules = input
            return { states: [], hasMore: false, total: 0 }
          },
        },
        projectionRuns: {
          list: async (input: unknown) => {
            received.projections = input
            return emptyRuns
          },
        },
        workflowRuns: {
          getById: async () => ({ workflowId: "allowed-workflow" }),
          list: async (input: unknown) => {
            received.workflows = input
            return emptyRuns
          },
          nodes: {
            list: async (input: unknown) => {
              received.workflowNodes = input
              return { nodes: [], hasMore: false, total: 0 }
            },
          },
        },
        workflowInterventions: {
          list: async (input: unknown) => {
            received.workflowInterventions = input
            return { interventions: [], hasMore: false, total: 0 }
          },
        },
        agents: {
          threads: {
            getById: async () => ({ agentId: "allowed-agent", ownerPrincipal: principal }),
            list: async (input: unknown) => {
              received.agentThreads = input
              return { threads: [], hasMore: false, total: 0 }
            },
          },
          runs: {
            list: async (input: unknown) => {
              received.agentRuns = input
              return emptyRuns
            },
          },
        },
        pipelineRuns: {
          getById: async () => ({ pipelineId: "allowed-pipeline" }),
          list: async (input: unknown) => {
            received.pipelines = input
            return emptyRuns
          },
          listSteps: async (input: unknown) => {
            received.pipelineSteps = input
            return { steps: [], hasMore: false, total: 0 }
          },
        },
      },
    })
    const catalog = (allowedId: string, deniedId: string) => ({
      list: () => [{ id: allowedId }, { id: deniedId }],
      getById: (id: string) => (id === allowedId ? { id } : null),
    })
    // These fields are absent from the public input types. `never` deliberately simulates an
    // untyped JavaScript caller injecting them at runtime across the TypeScript boundary.
    const injected = (input: Record<string, unknown>): never => input as never

    await createActionsRuntime(runtime, scope.execution).runs.list(
      injected({
        limit: 7,
        projectId: "attacker-project",
        actionIds: ["attacker-action"],
        objectTypeIds: ["HiddenObject"],
      })
    )
    await createSyncsRuntime(
      runtime,
      scope.execution,
      catalog("allowed-sync", "denied-sync") as never
    ).runs.list(injected({ limit: 7, projectId: "attacker-project", syncIds: ["denied-sync"] }))
    await createRulesRuntime(runtime, catalog("allowed-rule", "denied-rule") as never).states.list(
      injected({ limit: 7, projectId: "attacker-project", objectTypeIds: ["HiddenObject"] })
    )
    await createProjectionsRuntime(runtime, {} as ProjectionDefinitionCatalog).runs.list(
      injected({ limit: 7, projectId: "attacker-project", objectTypeIds: ["HiddenObject"] })
    )
    const workflows = createWorkflowsRuntime(
      runtime,
      scope.execution,
      catalog("allowed-workflow", "denied-workflow") as never
    )
    await workflows.runs.list(
      injected({ limit: 7, projectId: "attacker-project", workflowIds: ["denied-workflow"] })
    )
    await workflows.interventions.list(
      injected({ limit: 7, projectId: "attacker-project", workflowIds: ["denied-workflow"] })
    )
    await workflows.runs.listNodes(
      "allowed-workflow-run",
      injected({
        limit: 7,
        projectId: "attacker-project",
        workflowRunId: "attacker-workflow-run",
      })
    )
    const agents = createAgentsRuntime(
      runtime,
      scope.execution,
      catalog("allowed-agent", "denied-agent") as never,
      {} as never
    )
    await agents.threads.list(
      injected({
        limit: 7,
        projectId: "attacker-project",
        agentIds: ["denied-agent"],
        ownerPrincipal: { type: "user", id: "attacker" },
      })
    )
    await agents.runs.listForThread(
      "allowed-thread",
      injected({ limit: 7, projectId: "attacker-project", threadId: "attacker-thread" })
    )
    const pipelines = createPipelinesRuntime(
      runtime,
      scope.execution,
      catalog("allowed-pipeline", "denied-pipeline") as never
    )
    await pipelines.runs.list(
      injected({ limit: 7, projectId: "attacker-project", pipelineIds: ["denied-pipeline"] })
    )
    await pipelines.runs.listSteps(
      "allowed-pipeline-run",
      injected({
        limit: 7,
        projectId: "attacker-project",
        pipelineRunId: "attacker-pipeline-run",
      })
    )

    // Regression proof: move any bound field before `...input` in its list facade; the matching
    // captured input below becomes attacker-controlled and this assertion fails.
    expect(received).toEqual({
      actions: {
        limit: 7,
        actionIds: ["allowed-action"],
        objectTypeIds: ["VisibleObject"],
        projectId: "project-1",
      },
      syncs: { limit: 7, syncIds: ["allowed-sync"], projectId: "project-1" },
      rules: { limit: 7, objectTypeIds: ["VisibleObject"], projectId: "project-1" },
      projections: { limit: 7, objectTypeIds: ["VisibleObject"], projectId: "project-1" },
      workflows: { limit: 7, workflowIds: ["allowed-workflow"], projectId: "project-1" },
      workflowInterventions: {
        limit: 7,
        workflowIds: ["allowed-workflow"],
        projectId: "project-1",
      },
      workflowNodes: {
        limit: 7,
        workflowRunId: "allowed-workflow-run",
        projectId: "project-1",
      },
      agentThreads: {
        limit: 7,
        agentIds: ["allowed-agent"],
        ownerPrincipal: principal,
        projectId: "project-1",
      },
      agentRuns: { limit: 7, threadId: "allowed-thread", projectId: "project-1" },
      pipelines: { limit: 7, pipelineIds: ["allowed-pipeline"], projectId: "project-1" },
      pipelineSteps: {
        limit: 7,
        pipelineRunId: "allowed-pipeline-run",
        projectId: "project-1",
      },
    })
  })

  test("unrestricted broad and history listings preserve undefined provider filters", async () => {
    const filters: Record<string, unknown> = {}
    const unrestricted = createTestingScope({ projectId: "project-1" }).authorization
    const runtime = runtimeWith(unrestricted, {
      objectReader: {
        list: async (input: { objectTypeId?: readonly string[] }) => {
          filters.objectTypeIds = input.objectTypeId
          return { objects: [], hasMore: false, total: 0 }
        },
      },
      ontology: {
        listObjectTypes: () => {
          throw new Error("Unrestricted object lists must not derive a current-ontology filter.")
        },
      },
      storage: {
        pipelineRuns: {
          list: async (input: { pipelineIds?: readonly string[] }) => {
            filters.pipelineIds = input.pipelineIds
            return { runs: [], hasMore: false, total: 0 }
          },
        },
        syncRuns: {
          list: async (input: { syncIds?: readonly string[] }) => {
            filters.syncIds = input.syncIds
            return { runs: [], hasMore: false, total: 0 }
          },
        },
        workflowRuns: {
          list: async (input: { workflowIds?: readonly string[] }) => {
            filters.workflowIds = input.workflowIds
            return { runs: [], hasMore: false, total: 0 }
          },
        },
        workflowInterventions: {
          list: async (input: { workflowIds?: readonly string[] }) => {
            filters.interventionWorkflowIds = input.workflowIds
            return { interventions: [], hasMore: false, total: 0 }
          },
        },
      },
    })
    const emptyCatalog = {
      list: () => {
        throw new Error("Unrestricted history filters must not depend on current definitions.")
      },
      getById: () => null,
    }

    await listObjects(runtime, {})
    await createPipelinesRuntime(runtime, execution, emptyCatalog).runs.list()
    await createSyncsRuntime(runtime, execution, emptyCatalog).runs.list()
    const workflows = createWorkflowsRuntime(runtime, execution, emptyCatalog)
    await workflows.runs.list()
    await workflows.interventions.list()

    expect(filters).toEqual({
      objectTypeIds: undefined,
      pipelineIds: undefined,
      syncIds: undefined,
      workflowIds: undefined,
      interventionWorkflowIds: undefined,
    })
  })
})
