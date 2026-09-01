import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  defineAction,
  defineObjectType,
  type OntologyRegistry,
  prop,
  SixbHost,
} from "../src"
import { createActionsRuntime } from "../src/actions/execution"
import { requestAction, waitForActionRun } from "../src/actions/request"
import { AuthorizationError } from "../src/authorization"
import { createDisabledRuntimeAuthorization } from "../src/execution/authorization"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import type { ExecutionScope } from "../src/execution/types"
import type { SixbRuntimeContext } from "../src/runtime/types"
import type { SelectedObjectReadScope } from "../src/storage"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Proposal = defineObjectType({
  id: "DelegatedActionProposal",
  name: "Delegated Action Proposal",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const ArchivedProposal = defineObjectType({
  id: "DelegatedActionArchivedProposal",
  name: "Delegated Action Archived Proposal",
  extends: Proposal,
  properties: [prop("archived", "boolean", { required: true })],
})

const approve = defineAction("delegated-action-approve")
  .on(Proposal)
  .params({})
  .writeback(async () => {})

const reject = defineAction("delegated-action-reject")
  .on(Proposal)
  .params({})
  .writeback(async () => {})

const refresh = defineAction("delegated-action-refresh")
  .params({})
  .writeback(async () => {})

type ActionTarget = {
  readonly actionId: string
  readonly subject: { readonly objectTypeId: string; readonly primaryId: string }
}

type RuntimeHost = Omit<
  SixbRuntimeContext,
  "authorization" | "objectReader" | "runtimeAuthorization"
>

function actionDefinition(action: unknown): ActionDefinition {
  return action as ActionDefinition
}

async function createFixture() {
  const runtimeDeps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "delegated-action-admission",
    ontology: [Proposal, ArchivedProposal],
    actions: [actionDefinition(approve), actionDefinition(reject), actionDefinition(refresh)],
    ...runtimeDeps,
  })
  const sixb = createTestSixb(host)
  await sixb.objects(Proposal).upsert({ properties: { id: "proposal-1" } })
  await sixb.objects(Proposal).upsert({ properties: { id: "proposal-2" } })
  await sixb.objects(ArchivedProposal).upsert({
    properties: { id: "archived-1", archived: true },
  })
  const runtimeHost: RuntimeHost = {
    projectId: host.id,
    broker: host.broker,
    ontology: host.definitions.ontology as OntologyRegistry,
    actionRegistry: host.definitions.actions,
    events: host.events,
    storage: host.storage,
    queues: host.queues,
  }
  return { runtimeHost, runtimeDeps }
}

function createDelegatedRuntime(
  host: RuntimeHost,
  input: {
    readonly selected: readonly { readonly objectTypeId: string; readonly primaryId: string }[]
    readonly actionApply?: readonly ActionTarget[]
    readonly requestId: string
  }
): { readonly runtime: SixbRuntimeContext; readonly scope: ExecutionScope } {
  const scope = createDelegatedRequestScope({
    projectId: host.projectId,
    requestId: input.requestId,
    correlationId: `${input.requestId}-correlation`,
    objectRead: {
      selection: selectedObjects(input.selected),
      limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 100_000 },
    },
    actionApply: input.actionApply,
  })
  const runtime: SixbRuntimeContext = {
    projectId: host.projectId,
    broker: host.broker,
    ontology: host.ontology,
    actionRegistry: host.actionRegistry,
    events: host.events,
    storage: host.storage,
    queues: host.queues,
    runtimeAuthorization: scope.authorization,
    objectReader: createAuthorizedObjectReader({
      scope,
      ontology: host.ontology,
      objectStorage: host.storage.objects,
    }),
  }
  return { runtime, scope }
}

function selectedObjects(
  refs: readonly { readonly objectTypeId: string; readonly primaryId: string }[]
): SelectedObjectReadScope {
  return {
    kind: "selected",
    roots: refs.map((ref) => ({
      anchor: ref,
      node: {
        objects: [
          {
            objectTypeId: ref.objectTypeId,
            propertyIds: ref.objectTypeId === ArchivedProposal.id ? ["id", "archived"] : ["id"],
          },
        ],
        links: [],
      },
    })),
  }
}

function target(actionId: string, objectTypeId: string, primaryId: string): ActionTarget {
  return { actionId, subject: { objectTypeId, primaryId } }
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationError)
    return (error as Error).message
  }
  throw new Error("expected delegated Action request to be denied")
}

describe("delegated Action admission", () => {
  test("preserves exact Action and ObjectRef pairs without a type-wide fallback", async () => {
    const { runtimeHost } = await createFixture()
    const { runtime, scope } = createDelegatedRuntime(runtimeHost, {
      requestId: "cross-pairs",
      selected: [
        { objectTypeId: Proposal.id, primaryId: "proposal-1" },
        { objectTypeId: Proposal.id, primaryId: "proposal-2" },
      ],
      actionApply: [
        target(approve.id, Proposal.id, "proposal-1"),
        target(reject.id, Proposal.id, "proposal-2"),
      ],
    })

    await expect(
      requestAction(runtime, scope.execution, {
        actionId: approve.id,
        subject: { kind: "object", objectTypeId: Proposal.id, primaryId: "proposal-2" },
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      requestAction(runtime, scope.execution, {
        actionId: reject.id,
        subject: { kind: "object", objectTypeId: Proposal.id, primaryId: "proposal-1" },
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      requestAction(runtime, scope.execution, {
        actionId: "unknown-action",
        subject: { kind: "object", objectTypeId: Proposal.id, primaryId: "proposal-1" },
      })
    ).rejects.toMatchObject({
      name: "AuthorizationError",
      message: expect.not.stringContaining("Unknown action"),
    })
  })

  test("makes an unselected exact target indistinguishable from a missing pair", async () => {
    const { runtimeHost } = await createFixture()
    const selected = [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }]
    const missingPair = createDelegatedRuntime(runtimeHost, {
      requestId: "missing-pair",
      selected,
      actionApply: [],
    })
    const unselectedTarget = createDelegatedRuntime(runtimeHost, {
      requestId: "unselected-target",
      selected,
      actionApply: [target(approve.id, Proposal.id, "proposal-2")],
    })
    const request = {
      actionId: approve.id,
      subject: { kind: "object" as const, objectTypeId: Proposal.id, primaryId: "proposal-2" },
    }

    const missingPairMessage = await rejectedMessage(
      requestAction(missingPair.runtime, missingPair.scope.execution, request)
    )
    const unselectedTargetMessage = await rejectedMessage(
      requestAction(unselectedTarget.runtime, unselectedTarget.scope.execution, request)
    )
    expect(unselectedTargetMessage).toBe(missingPairMessage)
  })

  test("rejects global Actions and inherited parent Actions in delegated V1", async () => {
    const { runtimeHost } = await createFixture()
    const global = createDelegatedRuntime(runtimeHost, {
      requestId: "global-action",
      selected: [],
    })
    await expect(
      requestAction(global.runtime, global.scope.execution, { actionId: refresh.id })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      requestAction(global.runtime, global.scope.execution, { actionId: approve.id })
    ).rejects.toBeInstanceOf(AuthorizationError)

    const inherited = createDelegatedRuntime(runtimeHost, {
      requestId: "inherited-action",
      selected: [{ objectTypeId: ArchivedProposal.id, primaryId: "archived-1" }],
      actionApply: [target(approve.id, ArchivedProposal.id, "archived-1")],
    })
    await expect(
      requestAction(inherited.runtime, inherited.scope.execution, {
        actionId: approve.id,
        subject: {
          kind: "object",
          objectTypeId: ArchivedProposal.id,
          primaryId: "archived-1",
        },
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  test("captures one request and stops an admitted pair before durable run lookup", async () => {
    const { runtimeHost, runtimeDeps } = await createFixture()
    const { runtime, scope } = createDelegatedRuntime(runtimeHost, {
      requestId: "admitted-pair",
      selected: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
      actionApply: [target(approve.id, Proposal.id, "proposal-1")],
    })
    const delegatedReader = runtime.objectReader
    const disabledAuthorization = createDisabledRuntimeAuthorization(scope.execution)
    const disabledReader = createAuthorizedObjectReader({
      scope: { execution: scope.execution, authorization: disabledAuthorization },
      ontology: runtimeHost.ontology,
      objectStorage: runtimeHost.storage.objects,
    })
    let authorizationReads = 0
    let readerReads = 0
    const hostileRuntime = Object.defineProperties(
      { ...runtime },
      {
        runtimeAuthorization: {
          enumerable: true,
          get: () => {
            authorizationReads += 1
            return authorizationReads === 1 ? scope.authorization : disabledAuthorization
          },
        },
        objectReader: {
          enumerable: true,
          get: () => {
            readerReads += 1
            return readerReads === 1 ? delegatedReader : disabledReader
          },
        },
      }
    ) as SixbRuntimeContext
    const actionRuns = runtimeDeps.storage.actionRuns
    if (!actionRuns) throw new Error("test storage requires Action runs")
    let runReads = 0
    const restore = decorateOperationScopedMethodForTesting(actionRuns, "getById", (getById) => {
      return async (input) => {
        runReads += 1
        return getById(input)
      }
    })
    let actionIdReads = 0
    let subjectReads = 0
    let objectTypeIdReads = 0
    let primaryIdReads = 0
    let paramsReads = 0
    let runIdReads = 0
    const subject = Object.defineProperties(
      { kind: "object" },
      {
        objectTypeId: {
          enumerable: true,
          get: () => {
            objectTypeIdReads += 1
            return Proposal.id
          },
        },
        primaryId: {
          enumerable: true,
          get: () => {
            primaryIdReads += 1
            return "proposal-1"
          },
        },
      }
    )
    const request = Object.defineProperties(
      {},
      {
        actionId: {
          enumerable: true,
          get: () => {
            actionIdReads += 1
            return actionIdReads === 1 ? approve.id : reject.id
          },
        },
        subject: {
          enumerable: true,
          get: () => {
            subjectReads += 1
            return subject
          },
        },
        params: {
          enumerable: true,
          get: () => {
            paramsReads += 1
            return {}
          },
        },
        runId: {
          enumerable: true,
          get: () => {
            runIdReads += 1
            return "delegated-action-existing-or-guessed-run"
          },
        },
      }
    ) as Parameters<typeof requestAction>[2]

    try {
      await expect(requestAction(hostileRuntime, scope.execution, request)).rejects.toThrow(
        "cannot cross a durable execution boundary"
      )
      expect(authorizationReads).toBe(1)
      expect(readerReads).toBe(1)
      expect(actionIdReads).toBe(1)
      expect(subjectReads).toBe(1)
      expect(objectTypeIdReads).toBe(1)
      expect(primaryIdReads).toBe(1)
      expect(paramsReads).toBe(1)
      expect(runIdReads).toBe(1)
      expect(runReads).toBe(0)
    } finally {
      restore()
    }
  })

  test("keeps delegated Action metadata, runs, and polling closed before activation", async () => {
    const { runtimeHost, runtimeDeps } = await createFixture()
    const { runtime, scope } = createDelegatedRuntime(runtimeHost, {
      requestId: "closed-action-surfaces",
      selected: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
      actionApply: [target(approve.id, Proposal.id, "proposal-1")],
    })
    const actionRuns = runtimeDeps.storage.actionRuns
    if (!actionRuns) throw new Error("test storage requires Action runs")
    let getReads = 0
    let listReads = 0
    const restoreGet = decorateOperationScopedMethodForTesting(actionRuns, "getById", (getById) => {
      return async (input) => {
        getReads += 1
        return getById(input)
      }
    })
    const restoreList = decorateOperationScopedMethodForTesting(actionRuns, "list", (list) => {
      return async (input) => {
        listReads += 1
        return list(input)
      }
    })

    try {
      const actions = createActionsRuntime(runtime, scope.execution)
      expect(actions.list()).toEqual([])
      expect(actions.getById(approve.id)).toBeNull()
      expect(actions.listGlobal()).toEqual([])
      expect(actions.listForType(Proposal)).toEqual([])
      await expect(actions.runs.getById("guessed-run")).resolves.toBeNull()
      await expect(actions.runs.list()).resolves.toEqual({ runs: [], hasMore: false, total: 0 })
      await expect(waitForActionRun(runtime, { runId: "guessed-run" })).rejects.toThrow(
        "cannot cross a durable execution boundary"
      )
      expect(getReads).toBe(0)
      expect(listReads).toBe(0)
    } finally {
      restoreList()
      restoreGet()
    }
  })

  test("pins Action run storage to the runtime capabilities captured at construction", async () => {
    const { runtimeHost, runtimeDeps } = await createFixture()
    const scope = createTestingScope({ projectId: runtimeHost.projectId })
    const foreignScope = createTestingScope({ projectId: "foreign-project" })
    const reader = createAuthorizedObjectReader({
      scope,
      ontology: runtimeHost.ontology,
      objectStorage: runtimeHost.storage.objects,
    })
    let projectIdReads = 0
    let authorizationReads = 0
    const runtime = Object.defineProperties(
      { ...runtimeHost, objectReader: reader },
      {
        projectId: {
          enumerable: true,
          get: () => {
            projectIdReads += 1
            return projectIdReads === 1 ? runtimeHost.projectId : "foreign-project"
          },
        },
        runtimeAuthorization: {
          enumerable: true,
          get: () => {
            authorizationReads += 1
            return authorizationReads === 1 ? scope.authorization : foreignScope.authorization
          },
        },
      }
    ) as SixbRuntimeContext
    const actionRuns = runtimeDeps.storage.actionRuns
    if (!actionRuns) throw new Error("test storage requires Action runs")
    const providerProjects: string[] = []
    const restoreGet = decorateOperationScopedMethodForTesting(actionRuns, "getById", (getById) => {
      return async (input) => {
        providerProjects.push(input.projectId)
        return getById(input)
      }
    })
    const restoreList = decorateOperationScopedMethodForTesting(actionRuns, "list", (list) => {
      return async (input) => {
        providerProjects.push(input.projectId)
        return list(input)
      }
    })

    try {
      const actions = createActionsRuntime(runtime, scope.execution)
      await expect(actions.runs.getById("missing-run")).resolves.toBeNull()
      await expect(actions.runs.list({ projectId: "foreign-project" } as never)).resolves.toEqual({
        runs: [],
        hasMore: false,
        total: 0,
      })
      expect(projectIdReads).toBe(1)
      expect(authorizationReads).toBe(1)
      expect(providerProjects).toEqual([runtimeHost.projectId, runtimeHost.projectId])
    } finally {
      restoreList()
      restoreGet()
    }
  })
})
