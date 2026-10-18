import { afterEach, describe, expect, jest, test } from "bun:test"
import { ConnectorService } from "../src/connectors/service"
import {
  authorize,
  callbackUrl,
  connectAccount,
  createGate,
  createHarness,
  expectSixbError,
  getAuthorization,
  listAuthorizationConnections,
  managementCommand,
  projectOwner,
  rejectionOf,
  requireConnectionProcess,
  serializedSnapshot,
  settle,
} from "./connector-connections.fixture"

// A fake-timer test that times out never reaches its own cleanup; keep it from leaking.
afterEach(() => {
  jest.useRealTimers()
})

describe("connector connection lifecycle", () => {
  test("shares one authorization, disconnects one connection, and revokes all remaining", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    const first = await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "ads",
    })
    expect(
      await listAuthorizationConnections(harness.connectionStorage, authorization.authorizationId)
    ).toHaveLength(2)

    await harness.process.disconnect(managementCommand(), harness.connector.id, first.id)
    expect(
      await listAuthorizationConnections(harness.connectionStorage, authorization.authorizationId)
    ).toHaveLength(1)
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("active")

    const revoked = await harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorization.authorizationId
    )
    expect(revoked.affectedConnections.map((connection) => connection.slot)).toEqual(["ads"])
    expect(revoked.affectedConnections[0].status).toBe("disconnected")
    expect(
      await listAuthorizationConnections(harness.connectionStorage, authorization.authorizationId)
    ).toHaveLength(0)
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("keeps the last disconnected connection durable while provider cleanup is retryable", async () => {
    const harness = createHarness()
    const { authorizationId, connection } = await connectAccount(harness)
    harness.setRevokeError(new Error("temporary provider failure"))

    await expect(
      harness.process.disconnect(managementCommand(), harness.connector.id, connection.id)
    ).resolves.toMatchObject({ id: connection.id, status: "disconnected" })
    expect(await getAuthorization(harness.connectionStorage, authorizationId)).toMatchObject({
      status: "revocation_pending",
    })
    expect(
      await harness.connectionStorage.getConnectionById({
        projectId: "project",
        connectorId: harness.connector.id,
        connectionId: connection.id,
      })
    ).toMatchObject({ status: "disconnected" })

    harness.setRevokeError(undefined)
    await harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorizationId
    )
    expect(await getAuthorization(harness.connectionStorage, authorizationId)).toMatchObject({
      status: "revoked",
      credentials: undefined,
    })
    expect(harness.counts().revokeCount).toBe(2)
  })

  test("keeps provider revocation pending when credentials cannot be opened", async () => {
    const harness = createHarness()
    const { authorizationId } = await connectAccount(harness)
    const decryptionError = new Error("missing decryption key")
    const process = requireConnectionProcess(
      new ConnectorService("project", [harness.connector], {
        storage: harness.storage,
        credentialProtector: {
          seal: (plaintext, credentialContext) =>
            harness.protector.seal(plaintext, credentialContext),
          open: async () => {
            throw decryptionError
          },
        },
      })
    )

    const error = expectSixbError(
      await rejectionOf(
        process.revokeAuthorization(managementCommand(), harness.connector.id, authorizationId)
      ),
      "connector.credentials_unavailable"
    )
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(decryptionError)
    expect(error.message).not.toContain("missing decryption key")
    expect((await getAuthorization(harness.connectionStorage, authorizationId))?.status).toBe(
      "revocation_pending"
    )
    expect(await listAuthorizationConnections(harness.connectionStorage, authorizationId)).toEqual(
      []
    )

    await harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorizationId
    )
    expect((await getAuthorization(harness.connectionStorage, authorizationId))?.status).toBe(
      "revoked"
    )
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("retries provider revocation without reconnecting local usages", async () => {
    const harness = createHarness()
    const { authorizationId } = await connectAccount(harness)
    const providerError = new Error("temporary provider failure")
    harness.setRevokeError(providerError)

    const error = expectSixbError(
      await rejectionOf(
        harness.process.revokeAuthorization(
          managementCommand(),
          harness.connector.id,
          authorizationId
        )
      ),
      "connector.revocation_pending"
    )
    expect(error.retryable).toBe(true)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain("temporary provider failure")
    expect((await getAuthorization(harness.connectionStorage, authorizationId))?.status).toBe(
      "revocation_pending"
    )
    expect(await listAuthorizationConnections(harness.connectionStorage, authorizationId)).toEqual(
      []
    )

    harness.setRevokeError(undefined)
    await harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorizationId
    )
    expect((await getAuthorization(harness.connectionStorage, authorizationId))?.status).toBe(
      "revoked"
    )
    expect(harness.counts().revokeCount).toBe(2)
  })

  test("coalesces concurrent revocation attempts across service instances", async () => {
    const harness = createHarness()
    const { authorizationId } = await connectAccount(harness)
    const revoke = createGate()
    harness.setRevokeGate(revoke.wait)
    const peer = requireConnectionProcess(harness.peer())

    // The peer polls storage on a timer while the first revocation holds the credential mutation.
    jest.useFakeTimers()
    try {
      const first = harness.process.revokeAuthorization(
        managementCommand(),
        harness.connector.id,
        authorizationId
      )
      await revoke.entered
      const second = peer.revokeAuthorization(
        managementCommand(),
        harness.connector.id,
        authorizationId
      )
      await settle()
      expect(harness.counts().revokeCount).toBe(1)

      revoke.release()
      await first
      jest.advanceTimersToNextTimer()
      await second
    } finally {
      jest.useRealTimers()
    }
    expect(harness.counts().revokeCount).toBe(1)
    expect((await getAuthorization(harness.connectionStorage, authorizationId))?.status).toBe(
      "revoked"
    )
  })

  test("preserves connection ids and requires explicit account replacement", async () => {
    const harness = createHarness()
    const firstAuthorization = await authorize(harness)
    const first = await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: firstAuthorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const secondAuthorization = await authorize(harness)
    const reauthorized = await harness.process.selectAccount(
      managementCommand(),
      harness.connector.id,
      {
        authorizationId: secondAuthorization.authorizationId,
        accountId: "account-a",
        owner: projectOwner,
        slot: "social",
      }
    )
    expect(reauthorized.id).toBe(first.id)
    expect(
      await getAuthorization(harness.connectionStorage, firstAuthorization.authorizationId)
    ).toMatchObject({ status: "revoked", credentials: undefined })
    expect(harness.counts().revokeCount).toBe(1)

    await expect(
      harness.process.selectAccount(managementCommand(), harness.connector.id, {
        authorizationId: secondAuthorization.authorizationId,
        accountId: "account-b",
        owner: projectOwner,
        slot: "social",
      })
    ).rejects.toThrow("explicit replacement is required")

    const replaced = await harness.process.selectAccount(
      managementCommand(),
      harness.connector.id,
      {
        authorizationId: secondAuthorization.authorizationId,
        accountId: "account-b",
        owner: projectOwner,
        slot: "social",
        replace: true,
      }
    )
    expect(replaced.id).toBe(first.id)
    expect(replaced.account.id).toBe("account-b")
  })

  test("reauthorizes every connection sharing a grant explicitly and atomically", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    const first = await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const second = await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "ads",
    })

    const revisionBefore = (await getAuthorization(
      harness.connectionStorage,
      authorization.authorizationId
    ))!.revision
    const started = await harness.process.startAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorization.authorizationId,
      }
    )
    expect(started.affectedConnections.map((connection) => connection.id).sort()).toEqual(
      [first.id, second.id].sort()
    )
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const completed = await harness.process.completeAuthorization(
      managementCommand(),
      harness.connector.id,
      { state, code: "authorization-code", redirectUri: callbackUrl }
    )

    expect(completed.authorizationId).toBe(authorization.authorizationId)
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.revision
    ).toBe(revisionBefore + 1)
    expect(
      (await listAuthorizationConnections(harness.connectionStorage, authorization.authorizationId))
        .map((connection) => connection.id)
        .sort()
    ).toEqual([first.id, second.id].sort())
  })

  test("reports a coded conflict when disconnect races with reauthorization", async () => {
    const harness = createHarness()
    const { authorizationId, connection } = await connectAccount(harness)
    const exchange = createGate()
    harness.setExchangeGate(exchange.wait)
    const started = await harness.process.startAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorizationId,
      }
    )
    const completing = harness.process.completeAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "authorization-code",
        redirectUri: callbackUrl,
      }
    )
    // Reauthorization exchanges the code only while it holds the credential mutation.
    await exchange.entered
    expect(
      (await getAuthorization(harness.connectionStorage, authorizationId))?.credentialMutation
    ).toBeDefined()

    expectSixbError(
      await rejectionOf(
        harness.process.disconnect(managementCommand(), harness.connector.id, connection.id)
      ),
      "connector.operation_conflict"
    )

    exchange.release()
    await completing
  })

  test("rejects an older reauthorization callback after a newer attempt completes", async () => {
    const harness = createHarness({ refreshSkewMs: 0 })
    const { authorizationId } = await connectAccount(harness)
    const startReauthorization = () =>
      harness.process.startAuthorization(managementCommand(), harness.connector.id, {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorizationId,
      })
    const older = await startReauthorization()
    const newer = await startReauthorization()

    await harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
      state: new URL(newer.authorizationUrl).searchParams.get("state")!,
      code: "newer-authorization-code",
      redirectUri: callbackUrl,
    })
    const completedRevision = (await getAuthorization(harness.connectionStorage, authorizationId))
      ?.revision

    const error = expectSixbError(
      await rejectionOf(
        harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
          state: new URL(older.authorizationUrl).searchParams.get("state")!,
          code: "older-authorization-code",
          redirectUri: callbackUrl,
        })
      ),
      "connector.authorization_invalid"
    )
    expect(error.retryable).toBe(false)
    expect(harness.counts().exchangeCount).toBe(2)
    expect((await getAuthorization(harness.connectionStorage, authorizationId))?.revision).toBe(
      completedRevision
    )
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    expect(await client.token()).toEqual({ accessToken: "access-secret-2", tokenType: "Bearer" })
  })

  test("restarts shared reauthorization if its affected connection set changes", async () => {
    const harness = createHarness()
    const { authorizationId } = await connectAccount(harness)
    const started = await harness.process.startAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorizationId,
      }
    )
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "ads",
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!

    await expect(
      harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
        state,
        code: "authorization-code",
        redirectUri: callbackUrl,
      })
    ).rejects.toThrow("changed; restart reauthorization")
    expect(harness.counts().exchangeCount).toBe(1)
  })

  test("bounds account discovery and keeps reauthorized credentials staged", async () => {
    const harness = createHarness({ providerOperationTimeoutMs: 20 })
    const { authorizationId } = await connectAccount(harness)
    const started = await harness.process.startAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorizationId,
      }
    )
    const discovery = createGate()
    harness.setDiscoverGate(discovery.wait)

    jest.useFakeTimers()
    try {
      const completing = rejectionOf(
        harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: "authorization-code",
          redirectUri: callbackUrl,
        })
      )
      await discovery.entered
      jest.advanceTimersByTime(20)
      expectSixbError(await completing, "connector.provider_failed")
    } finally {
      jest.useRealTimers()
    }
    expect(
      (await getAuthorization(harness.connectionStorage, authorizationId))?.credentialMutation
        ?.phase
    ).toBe("result_staged")
    expect(serializedSnapshot(harness.storage)).not.toContain("access-secret-2")

    harness.setDiscoverGate(undefined)
    await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const recovered = await getAuthorization(harness.connectionStorage, authorizationId)
    expect(recovered?.credentialMutation).toBeUndefined()
    expect(recovered?.status).toBe("active")
    expect(harness.counts().exchangeCount).toBe(2)
  })
})
