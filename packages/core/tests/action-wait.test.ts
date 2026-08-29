import { expect, spyOn, test } from "bun:test"
import { waitForActionRun } from "../src/actions/request"
import { emptyGrantIndex } from "../src/authorization"
import { createTestingScope } from "../src/execution/scopes"
import { ActionRunTimeoutError } from "../src/objects/action/errors"
import type { SixbRuntimeContext } from "../src/runtime/types"
import type { ActionRunRecord } from "../src/storage"

function runtimeWithSubscription(subscribe: () => Promise<() => void>): SixbRuntimeContext {
  return {
    projectId: "test",
    storage: {
      actionRuns: {
        getById: async () => null,
      },
    },
    events: { subscribe },
    runtimeAuthorization: createTestingScope({ projectId: "test" }).authorization,
  } as unknown as SixbRuntimeContext
}

const terminalRun: ActionRunRecord = {
  id: "run-secret",
  projectId: "test",
  executionId: "execution-secret",
  actionId: "admin-action",
  subject: { kind: "object", objectTypeId: "Secret", primaryId: "secret-1" },
  status: "succeeded",
  phase: "effects",
  queuedAt: new Date("2026-01-01T00:00:00.000Z"),
  finishedAt: new Date("2026-01-01T00:00:01.000Z"),
  params: { token: "must-not-leak" },
  idempotencyKey: "secret-key",
  writeback: {
    status: "succeeded",
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    result: { value: "must-not-leak" },
  },
}

function principalRuntimeForRun(input: {
  readonly actionIds?: readonly string[]
  readonly objectTypeIds?: readonly string[]
  readonly unrestricted?: boolean
}): { runtime: SixbRuntimeContext; calls: { reads: number; subscriptions: number } } {
  const calls = { reads: 0, subscriptions: 0 }
  const authorizationScope = input.unrestricted
    ? createTestingScope({ projectId: "test" })
    : createTestingScope({
        projectId: "test",
        context: {
          principal: { type: "user", id: "viewer" },
          groupIds: [],
          roleIds: [],
          grants: {
            ...emptyGrantIndex(),
            "apply:action": new Set(input.actionIds ?? []),
            "view:object": new Set(input.objectTypeIds ?? []),
          },
        },
      })
  return {
    calls,
    runtime: {
      projectId: "test",
      runtimeAuthorization: authorizationScope.authorization,
      storage: {
        actionRuns: {
          getById: async () => {
            calls.reads += 1
            return terminalRun
          },
        },
      },
      events: {
        subscribe: async () => {
          calls.subscriptions += 1
          return () => {}
        },
      },
    } as unknown as SixbRuntimeContext,
  }
}

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

test("a principal cannot wait for a run without action and subject visibility", async () => {
  for (const grants of [{}, { actionIds: [terminalRun.actionId] }, { objectTypeIds: ["Secret"] }]) {
    const { runtime, calls } = principalRuntimeForRun(grants)
    const outcome = await waitForActionRun(runtime, {
      runId: terminalRun.id,
      timeoutMs: 5,
    }).catch((error: unknown) => error)

    expect(outcome).toBeInstanceOf(ActionRunTimeoutError)
    expect(calls.reads).toBe(1)
    expect(calls.subscriptions).toBe(1)
  }
})

test("an authorized principal and unrestricted runtime can wait for a terminal run", async () => {
  const authorized = principalRuntimeForRun({
    actionIds: [terminalRun.actionId],
    objectTypeIds: ["Secret"],
  })
  const unrestricted = principalRuntimeForRun({ unrestricted: true })

  expect(await waitForActionRun(authorized.runtime, { runId: terminalRun.id })).toEqual(terminalRun)
  expect(await waitForActionRun(unrestricted.runtime, { runId: terminalRun.id })).toEqual(
    terminalRun
  )
  expect(authorized.calls).toEqual({ reads: 1, subscriptions: 1 })
  expect(unrestricted.calls).toEqual({ reads: 1, subscriptions: 1 })
})
