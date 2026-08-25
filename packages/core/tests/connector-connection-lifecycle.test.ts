import { describe, expect, test } from "bun:test"
import { ConnectorService } from "../src/connectors/service"
import {
  authorize,
  callbackUrl,
  createHarness,
  expectSixbError,
  getAuthorization,
  listAuthorizationConnections,
  managementCommand,
  projectOwner,
  rejectionOf,
  requireConnectionProcess,
  serializedSnapshot,
  waitForCredentialMutation,
} from "./connector-connections.fixture"

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
    expect(revoked.affectedConnections[0].status).toBe("revoked")
    expect(
      await listAuthorizationConnections(harness.connectionStorage, authorization.authorizationId)
    ).toHaveLength(0)
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("keeps provider revocation pending when credentials cannot be opened", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
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
        process.revokeAuthorization(
          managementCommand(),
          harness.connector.id,
          authorization.authorizationId
        )
      ),
      "connector.credentials_unavailable"
    )
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(decryptionError)
    expect(error.message).not.toContain("missing decryption key")
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revocation_pending")
    expect(
      await listAuthorizationConnections(harness.connectionStorage, authorization.authorizationId)
    ).toEqual([])

    await harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorization.authorizationId
    )
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("retries provider revocation without reconnecting local usages", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const providerError = new Error("temporary provider failure")
    harness.setRevokeError(providerError)

    const error = expectSixbError(
      await rejectionOf(
        harness.process.revokeAuthorization(
          managementCommand(),
          harness.connector.id,
          authorization.authorizationId
        )
      ),
      "connector.revocation_pending"
    )
    expect(error.retryable).toBe(true)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain("temporary provider failure")
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revocation_pending")
    expect(
      await listAuthorizationConnections(harness.connectionStorage, authorization.authorizationId)
    ).toEqual([])

    harness.setRevokeError(undefined)
    await harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorization.authorizationId
    )
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")
    expect(harness.counts().revokeCount).toBe(2)
  })

  test("converges when a retried provider revocation was already applied", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    harness.setRevokeAfterEffectError(new Error("provider response was lost"))

    expectSixbError(
      await rejectionOf(
        harness.process.revokeAuthorization(
          managementCommand(),
          harness.connector.id,
          authorization.authorizationId
        )
      ),
      "connector.revocation_pending"
    )
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revocation_pending")

    await harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorization.authorizationId
    )
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")
    expect(harness.counts().revokeCount).toBe(2)
  })

  test("coalesces concurrent revocation attempts across service instances", async () => {
    const harness = createHarness()
    let releaseRevoke!: () => void
    harness.setRevokeGate(new Promise<void>((resolve) => (releaseRevoke = resolve)))
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

    const first = harness.process.revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorization.authorizationId
    )
    await Bun.sleep(0)
    const second = requireConnectionProcess(secondService).revokeAuthorization(
      managementCommand(),
      harness.connector.id,
      authorization.authorizationId
    )
    await Bun.sleep(10)
    expect(harness.counts().revokeCount).toBe(1)
    releaseRevoke()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(harness.counts().revokeCount).toBe(1)
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")
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
    const authorization = await authorize(harness)
    const connection = await harness.process.selectAccount(
      managementCommand(),
      harness.connector.id,
      {
        authorizationId: authorization.authorizationId,
        accountId: "account-a",
        owner: projectOwner,
        slot: "social",
      }
    )
    let releaseExchange!: () => void
    harness.setExchangeGate(new Promise<void>((resolve) => (releaseExchange = resolve)))
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
    const completing = harness.process.completeAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "authorization-code",
        redirectUri: callbackUrl,
      }
    )
    await waitForCredentialMutation(harness.connectionStorage, authorization.authorizationId)

    expectSixbError(
      await rejectionOf(
        harness.process.disconnect(managementCommand(), harness.connector.id, connection.id)
      ),
      "connector.operation_conflict"
    )

    releaseExchange()
    await completing
  })

  test("rejects an older reauthorization callback after a newer attempt completes", async () => {
    const harness = createHarness({ refreshSkewMs: 0 })
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const startReauthorization = () =>
      harness.process.startAuthorization(managementCommand(), harness.connector.id, {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorization.authorizationId,
      })
    const older = await startReauthorization()
    const newer = await startReauthorization()

    await harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
      state: new URL(newer.authorizationUrl).searchParams.get("state")!,
      code: "newer-authorization-code",
      redirectUri: callbackUrl,
    })
    const completedRevision = (
      await getAuthorization(harness.connectionStorage, authorization.authorizationId)
    )?.revision

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
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.revision
    ).toBe(completedRevision)
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    expect(await client.token()).toEqual({ accessToken: "access-secret-2", tokenType: "Bearer" })
  })

  test("restarts shared reauthorization if its affected connection set changes", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
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
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
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
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
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
    harness.setDiscoverGate(new Promise<void>(() => {}))

    expectSixbError(
      await rejectionOf(
        harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: "authorization-code",
          redirectUri: callbackUrl,
        })
      ),
      "connector.provider_failed"
    )
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))
        ?.credentialMutation?.phase
    ).toBe("result_staged")
    expect(serializedSnapshot(harness.storage)).not.toContain("access-secret-2")

    harness.setDiscoverGate(undefined)
    await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const recovered = await getAuthorization(
      harness.connectionStorage,
      authorization.authorizationId
    )
    expect(recovered?.credentialMutation).toBeUndefined()
    expect(recovered?.status).toBe("active")
    expect(harness.counts().exchangeCount).toBe(2)
  })
})
