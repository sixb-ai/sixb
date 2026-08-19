import { expect, test } from "bun:test"
import { waitForActionRun } from "../src/actions/request"
import { ActionRunTimeoutError } from "../src/objects/action/errors"
import type { SixbRuntimeContext } from "../src/runtime/types"

/**
 * `waitForActionRun` subscribes asynchronously but releases the subscription from `cleanup()`,
 * which can run first. Under a real broker every subscription holds its own connection and poll
 * loop, so a subscription that is never released is a leaked connection per timed-out wait.
 *
 * To prove this test still guards the fix, drop the `if (settled)` branch from the `.then()` in
 * `packages/core/src/actions/request.ts`: the wait still times out, but nothing unsubscribes.
 */
test("a wait that times out releases a subscription that resolves afterwards", async () => {
  let releaseSubscription: (unsubscribe: () => void) => void = () => undefined
  const subscribed = new Promise<() => void>((resolve) => {
    releaseSubscription = resolve
  })
  let unsubscribeCount = 0

  const runtime = {
    projectId: "test",
    storage: {
      actionRuns: {
        getById: async () => null,
      },
    },
    events: {
      subscribe: () => subscribed,
    },
  } as unknown as SixbRuntimeContext

  const outcome = waitForActionRun(runtime, { runId: "act_run_1", timeoutMs: 25 }).then(
    () => undefined,
    (error: unknown) => error
  )

  expect(await outcome).toBeInstanceOf(ActionRunTimeoutError)

  // The subscription only arrives after the wait already gave up.
  let markReleased: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    markReleased = resolve
  })
  releaseSubscription(() => {
    unsubscribeCount += 1
    markReleased()
  })
  await released

  expect(unsubscribeCount).toBe(1)
})
