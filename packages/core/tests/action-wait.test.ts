import { expect, spyOn, test } from "bun:test"
import { waitForActionRun } from "../src/actions/request"
import { AuthorizationError, emptyGrantIndex } from "../src/authorization"
import { createDisabledRuntimeAuthorization } from "../src/execution/authorization"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import type { ExecutionScope } from "../src/execution/types"
import { ActionRunTimeoutError } from "../src/objects/action/errors"
import type { SixbRuntimeContext } from "../src/runtime/types"
import type { ActionRunRecord } from "../src/storage"

function runtimeWithSubscription(subscribe: () => Promise<() => void>): SixbRuntimeContext {
  const scope = createTestingScope({ projectId: "test" })
  return {
    projectId: "test",
    runtimeAuthorization: scope.authorization,
    storage: {
      actionRuns: {
        getById: async () => null,
      },
    },
    events: { subscribe },
  } as unknown as SixbRuntimeContext
}

function runtimeWithRecord(scope: ExecutionScope, record: ActionRunRecord): SixbRuntimeContext {
  return {
    projectId: "test",
    runtimeAuthorization: scope.authorization,
    storage: { actionRuns: { getById: async () => record } },
    events: { subscribe: async () => () => undefined },
  } as unknown as SixbRuntimeContext
}

const terminalRun: ActionRunRecord = {
  id: "secret-run",
  projectId: "test",
  executionId: "secret-execution",
  actionId: "secret-action",
  subject: { kind: "object", objectTypeId: "Secret", primaryId: "secret-1" },
  status: "succeeded",
  phase: "effects",
  queuedAt: new Date("2026-01-01T00:00:00.000Z"),
  finishedAt: new Date("2026-01-01T00:00:01.000Z"),
  params: { secret: "classified" },
  idempotencyKey: "action:test:secret-run",
}

test("a wait rejects cross-project authority before storage or broker access", async () => {
  const scope = createTestingScope({ projectId: "project-a" })
  let storageReads = 0
  let subscriptions = 0
  const runtime = {
    projectId: "project-b",
    runtimeAuthorization: scope.authorization,
    storage: {
      actionRuns: {
        getById: async () => {
          storageReads += 1
          return null
        },
      },
    },
    events: {
      subscribe: async () => {
        subscriptions += 1
        return () => undefined
      },
    },
  } as unknown as SixbRuntimeContext

  await expect(waitForActionRun(runtime, { runId: "guessed-run" })).rejects.toBeInstanceOf(
    AuthorizationError
  )
  expect(storageReads).toBe(0)
  expect(subscriptions).toBe(0)
})

test("a wait captures delegated authority once before its durable boundary", async () => {
  const scope = createDelegatedRequestScope({
    projectId: "test",
    requestId: "delegated-wait",
    correlationId: "delegated-wait-correlation",
    objectRead: {
      selection: { kind: "selected", roots: [] },
      limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
    },
  })
  const disabledAuthorization = createDisabledRuntimeAuthorization(scope.execution)
  let authorizationReads = 0
  let storageReads = 0
  let subscriptions = 0
  const runtime = Object.defineProperties(
    {
      projectId: "test",
      storage: {
        actionRuns: {
          getById: async () => {
            storageReads += 1
            return terminalRun
          },
        },
      },
      events: {
        subscribe: async () => {
          subscriptions += 1
          return () => undefined
        },
      },
    },
    {
      runtimeAuthorization: {
        enumerable: true,
        get: () => {
          authorizationReads += 1
          return authorizationReads === 1 ? scope.authorization : disabledAuthorization
        },
      },
    }
  ) as unknown as SixbRuntimeContext

  await expect(waitForActionRun(runtime, { runId: terminalRun.id })).rejects.toThrow(
    "cannot cross a durable execution boundary"
  )
  expect(authorizationReads).toBe(1)
  expect(storageReads).toBe(0)
  expect(subscriptions).toBe(0)
})

test("a wait never returns a terminal run hidden from its principal", async () => {
  const principalScope = createTestingScope({
    projectId: "test",
    context: {
      principal: { type: "user", id: "user-1" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    },
  })
  const hidden = await waitForActionRun(runtimeWithRecord(principalScope, terminalRun), {
    runId: terminalRun.id,
    timeoutMs: 5,
  }).catch((error: unknown) => error)

  expect(hidden).toBeInstanceOf(ActionRunTimeoutError)

  const unrestrictedScope = createTestingScope({ projectId: "test" })
  await expect(
    waitForActionRun(runtimeWithRecord(unrestrictedScope, terminalRun), {
      runId: terminalRun.id,
      timeoutMs: 25,
    })
  ).resolves.toBe(terminalRun)
})

/**
 * `waitForActionRun` subscribes asynchronously but releases the subscription from `cleanup()`,
 * which can run first. Under a real broker every subscription holds its own connection and poll
 * loop, so a subscription that is never released is a leaked connection per timed-out wait.
 *
 * To prove this test still guards the fix, drop the `if (settled)` branch from the `.then()` in
 * `packages/core/src/actions/request.ts`: the wait still times out, but nothing unsubscribes.
 */
test("a wait that times out releases a subscription that resolves afterwards", async () => {
  let resolveSubscription: (unsubscribe: () => void) => void = () => undefined
  const subscribed = new Promise<() => void>((resolve) => {
    resolveSubscription = resolve
  })
  let unsubscribeCount = 0

  const outcome = waitForActionRun(
    runtimeWithSubscription(() => subscribed),
    {
      runId: "act_run_1",
      timeoutMs: 25,
    }
  ).catch((error: unknown) => error)

  expect(await outcome).toBeInstanceOf(ActionRunTimeoutError)

  // The subscription only arrives after the wait already gave up.
  let markReleased: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    markReleased = resolve
  })
  resolveSubscription(() => {
    unsubscribeCount += 1
    markReleased()
  })
  await released

  expect(unsubscribeCount).toBe(1)
})

test("an unsubscribe failure does not prevent a wait from timing out", async () => {
  const releaseError = new Error("unsubscribe failed")
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined)

  try {
    const outcome = await waitForActionRun(
      runtimeWithSubscription(async () => () => {
        throw releaseError
      }),
      { runId: "act_run_1", timeoutMs: 25 }
    ).catch((error: unknown) => error)

    expect(outcome).toBeInstanceOf(ActionRunTimeoutError)
    expect(consoleError).toHaveBeenCalledWith(
      "[Sixb] Failed to release action run wait subscription:",
      releaseError
    )
  } finally {
    consoleError.mockRestore()
  }
})

test("a subscription failure that arrives after timeout is reported accurately", async () => {
  let rejectSubscription: (error: unknown) => void = () => undefined
  const subscribed = new Promise<() => void>((_resolve, reject) => {
    rejectSubscription = reject
  })
  const subscriptionError = new Error("subscribe failed")
  let markReported: () => void = () => undefined
  const reported = new Promise<void>((resolve) => {
    markReported = resolve
  })
  const consoleError = spyOn(console, "error").mockImplementation(() => {
    markReported()
  })

  try {
    const outcome = waitForActionRun(
      runtimeWithSubscription(() => subscribed),
      {
        runId: "act_run_1",
        timeoutMs: 25,
      }
    ).catch((error: unknown) => error)

    expect(await outcome).toBeInstanceOf(ActionRunTimeoutError)

    rejectSubscription(subscriptionError)
    await reported

    expect(consoleError).toHaveBeenCalledWith(
      "[Sixb] Action run wait subscription failed after the wait settled:",
      subscriptionError
    )
  } finally {
    consoleError.mockRestore()
  }
})
