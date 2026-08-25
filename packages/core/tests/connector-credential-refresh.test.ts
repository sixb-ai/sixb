import { describe, expect, test } from "bun:test"
import { ConnectorOAuthError } from "../src"
import { ConnectorService } from "../src/connectors/service"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import {
  authorize,
  callbackUrl,
  createHarness,
  expectSixbError,
  getAuthorization,
  managementCommand,
  projectOwner,
  rejectionOf,
  requireConnectionProcess,
} from "./connector-connections.fixture"

describe("connector credential refresh", () => {
  test("coordinates concurrent OAuth token refresh by authorization", async () => {
    const harness = createHarness()
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const secondService = new ConnectorService("project", [harness.connector], {
      storage: harness.storage,
      credentialProtector: harness.protector,
      now: harness.now,
    })
    const first = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const second = await secondService.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const revisionBefore = (await getAuthorization(
      harness.connectionStorage,
      authorization.authorizationId
    ))!.revision
    const tokens = Promise.all([first.token(), second.token()])
    await Bun.sleep(0)
    expect(harness.counts().refreshCount).toBe(1)
    releaseRefresh()

    expect(await tokens).toEqual([
      { accessToken: "rotated-access-1", tokenType: "Bearer" },
      { accessToken: "rotated-access-1", tokenType: "Bearer" },
    ])
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.revision
    ).toBe(revisionBefore + 1)
  })

  test("preserves omitted OAuth metadata across successive refreshes", async () => {
    const harness = createHarness({ refreshSkewMs: 0 })
    harness.setOmitRefreshMetadata(true)
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })

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
    const harness = createHarness()
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const management = requireConnectionProcess(
      new ConnectorService("project", [harness.connector], {
        storage: harness.storage,
        credentialProtector: harness.protector,
        now: harness.now,
      })
    )
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const refreshing = client.token()
    await Bun.sleep(0)

    const started = await management.startAuthorization(managementCommand(), harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
      reauthorizationId: authorization.authorizationId,
    })
    const reauthorizing = management.completeAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "authorization-code",
        redirectUri: callbackUrl,
      }
    )
    const reauthorizationFailure = rejectionOf(reauthorizing)
    await Bun.sleep(10)
    expect(harness.counts().exchangeCount).toBe(1)

    releaseRefresh()
    await refreshing
    expectSixbError(await reauthorizationFailure, "connector.authorization_invalid")
    expect(harness.counts()).toMatchObject({ refreshCount: 1, exchangeCount: 1 })
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("active")
  })

  test("serializes refresh and provider revocation", async () => {
    const harness = createHarness()
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const management = requireConnectionProcess(
      new ConnectorService("project", [harness.connector], {
        storage: harness.storage,
        credentialProtector: harness.protector,
        now: harness.now,
      })
    )
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const refreshing = client.token()
    await Bun.sleep(0)
    const revoking = management.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorization.authorizationId
    )
    await Bun.sleep(10)
    expect(harness.counts().revokeCount).toBe(0)

    releaseRefresh()
    await refreshing
    await revoking
    expect(harness.counts()).toMatchObject({ refreshCount: 1, revokeCount: 1 })
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")
  })

  test("renews a credential mutation lease during a slow provider refresh", async () => {
    const harness = createHarness({
      systemStorageClock: true,
      credentialMutationLeaseMs: 30,
      providerOperationTimeoutMs: 500,
    })
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const secondService = new ConnectorService("project", [harness.connector], {
      storage: harness.storage,
      credentialProtector: harness.protector,
      now: harness.now,
      credentialMutationLeaseMs: 30,
      providerOperationTimeoutMs: 500,
    })
    const first = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const second = await secondService.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const firstToken = first.token()
    await Bun.sleep(70)
    const secondToken = second.token()
    releaseRefresh()

    expect(await Promise.all([firstToken, secondToken])).toEqual([
      { accessToken: "rotated-access-1", tokenType: "Bearer" },
      { accessToken: "rotated-access-1", tokenType: "Bearer" },
    ])
    expect(harness.counts().refreshCount).toBe(1)
  })

  test("does not refresh again when an older delivered token is invalidated", async () => {
    const harness = createHarness({ refreshSkewMs: 0 })
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const first = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const second = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    expect(await Promise.all([first.token(), second.token()])).toEqual([
      { accessToken: "access-secret-1", tokenType: "Bearer" },
      { accessToken: "access-secret-1", tokenType: "Bearer" },
    ])

    first.invalidate()
    expect(await first.token()).toEqual({
      accessToken: "rotated-access-1",
      tokenType: "Bearer",
    })
    second.invalidate()
    expect(await second.token()).toEqual({
      accessToken: "rotated-access-1",
      tokenType: "Bearer",
    })
    expect(harness.counts().refreshCount).toBe(1)
  })

  test("binds invalidation to the exact token on one source", async () => {
    const harness = createHarness({ refreshSkewMs: 0 })
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })

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

  test("marks terminal refresh failures as needing reauthorization", async () => {
    const harness = createHarness()
    const providerError = new ConnectorOAuthError("terminal", "invalid_grant")
    harness.setRefreshError(providerError)
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })

    const error = expectSixbError(
      await rejectionOf(client.token()),
      "connector.authorization_required"
    )
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain("invalid_grant")
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("needs_reauthorization")
    await expect(client.token()).rejects.toThrow("require reauthorization")
    expect(harness.counts().refreshCount).toBe(1)
  })

  test("releases retryable refresh failures without poisoning the authorization", async () => {
    const harness = createHarness()
    const providerError = new ConnectorOAuthError("retryable", "provider secret")
    harness.setRefreshError(providerError)
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })

    const error = expectSixbError(
      await rejectionOf(client.token()),
      "connector.provider_unavailable"
    )
    expect(error.retryable).toBe(true)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain("provider secret")
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("active")
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))
        ?.credentialMutation
    ).toBeUndefined()

    harness.setRefreshError(undefined)
    await expect(client.token()).resolves.toEqual({
      accessToken: "rotated-access-2",
      tokenType: "Bearer",
    })
  })

  test("preserves provider and recovery failures when fail-safe storage handling also fails", async () => {
    const harness = createHarness()
    const providerError = new ConnectorOAuthError("retryable", "provider secret")
    const recoveryError = new Error("storage secret")
    harness.setRefreshError(providerError)
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
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
      expectSixbError(error.cause.errors[1], "internal.unexpected")
      expect((error.cause.errors[1] as Error & { cause?: unknown }).cause).toBe(recoveryError)
    } finally {
      restoreRelease()
    }
  })

  test("fails closed when a refresh outcome is ambiguous", async () => {
    const harness = createHarness()
    const providerError = new Error("connection reset")
    harness.setRefreshError(providerError)
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })

    const error = expectSixbError(
      await rejectionOf(client.token()),
      "connector.authorization_required"
    )
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain("connection reset")
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("needs_reauthorization")
  })
})
