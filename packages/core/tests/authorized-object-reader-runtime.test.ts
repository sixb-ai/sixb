import { describe, expect, test } from "bun:test"
import { createAgentRuntime } from "../src/agents/execution"
import { createDatasetsRuntime } from "../src/datasets/execution"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import { OntologyRegistry } from "../src/ontology"
import { createPipelinesRuntime } from "../src/pipelines/execution"
import { createProjectionsRuntime } from "../src/projections/execution"
import { createRulesRuntime } from "../src/rules/execution"
import { SixbHost } from "../src/runtime/host"
import { createBoundSixb, type SixbDependencies } from "../src/runtime/sixb"
import type { SixbRuntimeContext } from "../src/runtime/types"
import { createSchedulesRuntime } from "../src/schedules/execution"
import { InMemoryStorage } from "../src/storage"
import { createSyncsRuntime } from "../src/syncs/execution"
import { createWorkflowsRuntime } from "../src/workflows/execution"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "authorized-object-reader-runtime"

describe("AuthorizedObjectReader runtime binding", () => {
  test("SixbHost creates the bound reader before composing the SDK", () => {
    const host = new SixbHost({ id: projectId, ontology: [], ...createTestRuntimeDeps() })
    const scope = createTestingScope({ projectId, executionId: "execution-1" })

    expect(host.withScope(scope).execution).toBe(scope.execution)
  })

  test("SixbHost captures an accessor-backed scope once before composition", () => {
    const host = new SixbHost({ id: projectId, ontology: [], ...createTestRuntimeDeps() })
    const source = createTestingScope({ projectId, executionId: "execution-accessor" })
    let executionReads = 0
    let authorizationReads = 0
    const accessorScope = Object.defineProperties(
      {},
      {
        execution: {
          enumerable: true,
          get: () => {
            executionReads += 1
            return source.execution
          },
        },
        authorization: {
          enumerable: true,
          get: () => {
            authorizationReads += 1
            return source.authorization
          },
        },
      }
    ) as typeof source

    expect(host.withScope(accessorScope).execution).toBe(source.execution)
    expect(executionReads).toBe(1)
    expect(authorizationReads).toBe(1)
  })

  test("SixbHost binds selected reads while delegated non-object surfaces stay closed", async () => {
    const host = new SixbHost({ id: projectId, ontology: [], ...createTestRuntimeDeps() })
    const scope = createDelegatedRequestScope({
      projectId,
      requestId: "delegated-request",
      correlationId: "delegated-correlation",
      objectRead: {
        selection: { kind: "selected", roots: [] },
        limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
      },
    })

    const sixb = host.withScope(scope)
    expect(sixb.objects.listTypes()).toEqual([])
    // Reverting the authority guard in any facade makes its dependency trap fail this test.
    const trap = () => {
      throw new Error("Unscoped dependency access")
    }
    const runtime: SixbRuntimeContext = {
      projectId,
      runtimeAuthorization: scope.authorization,
      objectReader: createAuthorizedObjectReader({
        scope,
        ontology: host.definitions.ontology as OntologyRegistry,
        objectStorage: host.storage.objects,
      }),
      broker: host.broker,
      ontology: host.definitions.ontology as OntologyRegistry,
      actionRegistry: host.definitions.actions,
      events: host.events,
      queues: host.queues,
      get storage() {
        return trap()
      },
    }
    const source = { list: trap, getById: trap }
    const catalogs = [
      createDatasetsRuntime(runtime, scope.execution, source, host.lakeStorage, host.blobStorage),
      createWorkflowsRuntime(runtime, scope.execution, source),
      createSyncsRuntime(runtime, scope.execution, source),
      createPipelinesRuntime(runtime, scope.execution, source),
      createProjectionsRuntime(runtime, {
        ...source,
        listObjects: trap,
        listLinks: trap,
        listTelemetry: trap,
      }),
      createRulesRuntime(runtime, source),
      createSchedulesRuntime(runtime, source),
    ]
    for (const catalog of catalogs) {
      expect(catalog.list()).toEqual([])
      expect(catalog.getById("guessed")).toBeNull()
    }
    const agent = createAgentRuntime(runtime, scope.execution)
    expect(agent.get()).toBeNull()
    expect(await agent.threads.getById("guessed")).toBeNull()
    expect(await agent.threads.list()).toEqual({ threads: [], total: 0, hasMore: false })
    expect(await agent.runs.getById("guessed")).toBeNull()
    await expect(agent.runs.request({ text: "hello" })).rejects.toMatchObject({
      code: "agent_not_found",
    })
    host.events.read = async () => {
      throw new Error("Unscoped event read")
    }
    host.events.latestCursor = async () => {
      throw new Error("Unscoped cursor read")
    }
    host.events.subscribe = async () => {
      throw new Error("Unscoped subscription")
    }
    expect(await sixb.events.read()).toEqual([])
    expect(await sixb.events.latestCursor()).toBeUndefined()
    expect(typeof (await sixb.events.subscribe({}, () => {}))).toBe("function")
    expect(await sixb.workflows.runs.list()).toEqual({ runs: [], total: 0, hasMore: false })
    expect(await sixb.syncs.runs.list()).toEqual({ runs: [], total: 0, hasMore: false })
    expect(await sixb.pipelines.runs.list()).toEqual({ runs: [], total: 0, hasMore: false })
    expect(await sixb.projections.runs.list()).toEqual({ runs: [], total: 0, hasMore: false })
    expect(await sixb.agent.threads.list()).toEqual({ threads: [], total: 0, hasMore: false })
    expect(await sixb.rules.states.list()).toEqual({ states: [], total: 0, hasMore: false })
    expect(() => sixb.logs.read()).toThrow()
    expect(() => sixb.blobs.open("guessed")).toThrow()
    expect(() => sixb.events.append({ events: [] })).toThrow()
  })

  test("delegated AI usage cannot read limit policies or advertise management", () => {
    const deps = createTestRuntimeDeps()
    let policyReads = 0
    deps.storage.aiLimits.listPolicies = async () => {
      policyReads += 1
      return []
    }
    const host = new SixbHost({ id: projectId, ontology: [], ...deps })
    const scope = createDelegatedRequestScope({
      projectId,
      requestId: "delegated-ai-usage",
      correlationId: "delegated-ai-usage",
      objectRead: {
        selection: { kind: "selected", roots: [] },
        limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
      },
    })
    const sixb = host.withScope(scope)

    // Revert the AI usage facade's isRuntimeAllowed guards: policy reads succeed and
    // canManageLimits incorrectly advertises management for principal-free delegation.
    expect(() => sixb.aiUsage.listLimitPolicies()).toThrow("not covered by delegated authorization")
    expect(policyReads).toBe(0)
    expect(sixb.aiUsage.canManageLimits()).toBe(false)
  })

  test("createBoundSixb rejects a reader from another exact authority", () => {
    const ontology = new OntologyRegistry({ sources: [] })
    const storage = new InMemoryStorage()
    const boundScope = createTestingScope({ projectId, executionId: "execution-bound" })
    const foreignScope = createTestingScope({ projectId, executionId: "execution-foreign" })
    const foreignReader = createAuthorizedObjectReader({
      scope: foreignScope,
      ontology,
      objectStorage: storage.objects,
    })
    const runtime = {
      projectId,
      runtimeAuthorization: boundScope.authorization,
      objectReader: foreignReader,
    } as SixbRuntimeContext

    expect(() =>
      createBoundSixb<readonly []>(runtime, {} as SixbDependencies, boundScope.execution)
    ).toThrow("AuthorizedObjectReader is not bound to this exact execution authority")
  })
})
