import { afterEach, describe, expect, jest, test } from "bun:test"
import { ConnectorOAuthError } from "../src"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import {
  callbackUrl,
  connectAccount,
  createGate,
  createHarness,
  expectSixbError,
  getAuthorization,
  type HarnessOptions,
  managementCommand,
  projectOwner,
  rejectionOf,
  requireConnectionProcess,
  settle,
} from "./connector-connections.fixture"

// A fake-timer test that times out never reaches its own cleanup; keep it from leaking.
afterEach(() => {
  jest.useRealTimers()
})

const selector = { owner: projectOwner, slot: "social" }

async function connectedHarness(options: HarnessOptions = {}) {
  const harness = createHarness(options)
  const { authorizationId } = await connectAccount(harness)
  const authorization = () => getAuthorization(harness.connectionStorage, authorizationId)
  return { harness, authorizationId, authorization }
}

// The cross-instance cases run under fake timers: a peer waiting on another instance's credential
// mutation polls storage on a timer, which `advanceTimersToNextTimer()` fires once the holder is done.
describe("connector credential refresh", () => {
  test("coordinates concurrent OAuth token refresh by authorization", async () => {
    const { harness, authorization } = await connectedHarness()
    const refresh = createGate()
    harness.setRefreshGate(refresh.wait)
    const first = await harness.service.connectConnection(harness.connector, selector)
    const second = await harness.peer().connectConnection(harness.connector, selector)
    const revisionBefore = (await authorization())!.revision

    jest.useFakeTimers()
    try {
      const tokens = Promise.all([first.token(), second.token()])
      await refresh.entered
      await settle()
      expect(harness.counts().refreshCount).toBe(1)
      refresh.release()
      await settle()
      jest.advanceTimersToNextTimer()

      expect(await tokens).toEqual([
        { accessToken: "rotated-access-1", tokenType: "Bearer" },
        { accessToken: "rotated-access-1", tokenType: "Bearer" },
      ])
    } finally {
      jest.useRealTimers()
    }
    expect((await authorization())?.revision).toBe(revisionBefore + 1)
  })

  test("preserves omitted OAuth metadata across successive refreshes", async () => {
    const { harness } = await connectedHarness({ refreshSkewMs: 0 })
    harness.setOmitRefreshMetadata(true)
    const client = await harness.service.connectConnection(harness.connector, selector)

    harness.setNow(new Date("2026-08-19T12:00:31.000Z"))
    await expect(client.token()).resolves.toEqual({
      accessToken: "rotated-access-1",
      tokenType: "Bearer",
    })
    harness.setNow(new Date("2026-08-19T13:00:32.000Z"))
    await expect(client.token()).resolves.toEqual({
      accessToken: "rotated-access-2",
      tokenType: "Bearer",
    })

    expect(harness.refreshInputs).toHaveLength(2)
    expect(harness.refreshInputs[1]).toMatchObject({
      accessToken: "rotated-access-1",
      refreshToken: "refresh-secret-1",
      tokenType: "Bearer",
      scopes: ["accounts.read"],
    })
  })

  test("rejects reauthorization made stale by a concurrent refresh", async () => {
    const { harness, authorizationId, authorization } = await connectedHarness()
    const refresh = createGate()
    harness.setRefreshGate(refresh.wait)
    const management = requireConnectionProcess(harness.peer())
    const client = await harness.service.connectConnection(harness.connector, selector)

    jest.useFakeTimers()
    try {
      const refreshing = client.token()
      await refresh.entered
      const started = await management.startAuthorization(
        managementCommand(),
        harness.connector.id,
        {
          ...selector,
          redirectUri: callbackUrl,
          reauthorizationId: authorizationId,
        }
      )
      const reauthorization = rejectionOf(
        management.completeAuthorization(managementCommand(), harness.connector.id, {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: "authorization-code",
          redirectUri: callbackUrl,
        })
      )
      await settle()
      expect(harness.counts().exchangeCount).toBe(1)

      refresh.release()
      await refreshing
      jest.advanceTimersToNextTimer()
      expectSixbError(await reauthorization, "connector.authorization_invalid")
    } finally {
      jest.useRealTimers()
    }
    expect(harness.counts()).toMatchObject({ refreshCount: 1, exchangeCount: 1 })
    expect((await authorization())?.status).toBe("active")
  })

  test("serializes refresh and provider revocation", async () => {
    const { harness, authorizationId, authorization } = await connectedHarness()
    const refresh = createGate()
    harness.setRefreshGate(refresh.wait)
    const management = requireConnectionProcess(harness.peer())
    const client = await harness.service.connectConnection(harness.connector, selector)

    jest.useFakeTimers()
    try {
      const refreshing = client.token()
      await refresh.entered
      const revoking = management.revokeAuthorization(
        managementCommand(),
        harness.connector.id,
        authorizationId
      )
      await settle()
      expect(harness.counts().revokeCount).toBe(0)

      refresh.release()
      await refreshing
      jest.advanceTimersToNextTimer()
      await revoking
    } finally {
      jest.useRealTimers()
    }
    expect(harness.counts()).toMatchObject({ refreshCount: 1, revokeCount: 1 })
    expect((await authorization())?.status).toBe("revoked")
  })

  test("renews a credential mutation lease during a slow provider refresh", async () => {
    const leaseOptions = { credentialMutationLeaseMs: 30, providerOperationTimeoutMs: 500 }
    const { harness } = await connectedHarness({ systemStorageClock: true, ...leaseOptions })
    const refresh = createGate()
    harness.setRefreshGate(refresh.wait)
    const first = await harness.service.connectConnection(harness.connector, selector)
    const second = await harness.peer(leaseOptions).connectConnection(harness.connector, selector)

    jest.useFakeTimers()
    try {
      const firstToken = first.token()
      await refresh.entered
      // Hold the refresh for more than twice the lease; each heartbeat renewal must land in time.
      for (let elapsed = 0; elapsed < 70; elapsed += 10) {
        jest.advanceTimersByTime(10)
        await settle()
      }
      const secondToken = second.token()
      await settle()
      refresh.release()
      await settle()
      jest.advanceTimersToNextTimer()

      expect(await Promise.all([firstToken, secondToken])).toEqual([
        { accessToken: "rotated-access-1", tokenType: "Bearer" },
        { accessToken: "rotated-access-1", tokenType: "Bearer" },
      ])
    } finally {
      jest.useRealTimers()
    }
    expect(harness.counts().refreshCount).toBe(1)
  })

  test("binds invalidation to the exact token on one source", async () => {
    const { harness } = await connectedHarness({ refreshSkewMs: 0 })
    const client = await harness.service.connectConnection(harness.connector, selector)

    const stale = await client.tokenHandle()
    const rejected = await client.tokenHandle()
    rejected.invalidate()
    const current = await client.tokenHandle()
    expect(current.accessToken).toBe("rotated-access-1")

    stale.invalidate()
    const afterLateRejection = await client.tokenHandle()
    expect(afterLateRejection.accessToken).toBe("rotated-access-1")
    expect(harness.counts().refreshCount).toBe(1)
  })

  // Terminal and ambiguous outcomes share one fail-closed path: only a retryable error is released.
  test.each([
    ["terminal", new ConnectorOAuthError("terminal", "invalid_grant")],
    ["ambiguous", new Error("connection reset")],
  ])("marks %s refresh failures as needing reauthorization", async (_kind, providerError) => {
    const { harness, authorization } = await connectedHarness()
    harness.setRefreshError(providerError)
    const client = await harness.service.connectConnection(harness.connector, selector)

    const error = expectSixbError(
      await rejectionOf(client.token()),
      "connector.authorization_required"
    )
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain(providerError.message)
    expect((await authorization())?.status).toBe("needs_reauthorization")
    await expect(client.token()).rejects.toThrow("require reauthorization")
    expect(harness.counts().refreshCount).toBe(1)
  })

  test("releases retryable refresh failures without poisoning the authorization", async () => {
    const { harness, authorization } = await connectedHarness()
    const providerError = new ConnectorOAuthError("retryable", "provider secret")
    harness.setRefreshError(providerError)
    const client = await harness.service.connectConnection(harness.connector, selector)

    const error = expectSixbError(
      await rejectionOf(client.token()),
      "connector.provider_unavailable"
    )
    expect(error.retryable).toBe(true)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain("provider secret")
    expect(await authorization()).toMatchObject({ status: "active", credentialMutation: undefined })

    harness.setRefreshError(undefined)
    await expect(client.token()).resolves.toEqual({
      accessToken: "rotated-access-2",
      tokenType: "Bearer",
    })
  })

  test("preserves provider and recovery failures when fail-safe storage handling also fails", async () => {
    const { harness } = await connectedHarness()
    const providerError = new ConnectorOAuthError("retryable", "provider secret")
    const recoveryError = new Error("storage secret")
    harness.setRefreshError(providerError)
    const client = await harness.service.connectConnection(harness.connector, selector)
    const restoreRelease = decorateOperationScopedMethodForTesting(
      harness.connectionStorage,
      "releaseCredentialMutation",
      () => async () => {
        throw recoveryError
      }
    )

    try {
      const error = expectSixbError(await rejectionOf(client.token()), "internal.unexpected")
      expect(error.message).not.toContain("provider secret")
      expect(error.message).not.toContain("storage secret")
      expect(error.cause).toBeInstanceOf(AggregateError)
      if (!(error.cause instanceof AggregateError)) throw new Error("Expected aggregated causes.")
      expect(error.cause.errors[0]).toBe(providerError)
      const wrappedRecovery = expectSixbError(error.cause.errors[1], "internal.unexpected")
      expect(wrappedRecovery.cause).toBe(recoveryError)
    } finally {
      restoreRelease()
    }
  })
})
