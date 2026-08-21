import { expect, spyOn, test } from "bun:test"
import { waitForActionRun } from "../src/actions/request"
import { ActionRunTimeoutError } from "../src/objects/action/errors"
import type { SixbRuntimeContext } from "../src/runtime/types"

function runtimeWithSubscription(subscribe: () => Promise<() => void>): SixbRuntimeContext {
  return {
    projectId: "test",
    storage: {
      actionRuns: {
        getById: async () => null,
      },
    },
    events: { subscribe },
  } as unknown as SixbRuntimeContext
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
