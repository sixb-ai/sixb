import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  type AuthorizationContext,
  AuthorizationError,
  ConnectorOAuthError,
  col,
  defineConnector,
  defineDataset,
  defineSync,
  emptyGrantIndex,
  type SixbErrorCode,
  SixbHost,
  type SyncDefinition,
} from "../src"
import { createConnectorCredentialProtectorFromKey } from "../src/connectors/credentials"
import { ConnectorService, type ConnectorServiceOptions } from "../src/connectors/service"
import { isSixbError } from "../src/errors/internal"
import {
  createAgentScope,
  createPrincipalRequestScope,
  createTrustedPrimitiveScope,
} from "../src/execution/scopes"
import { InMemoryConnectorConnectionStorage } from "../src/storage/connector-connections"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const callbackUrl = "https://app.test/api/connectors/callback"
const projectOwner = { type: "project" } as const
const encryptionKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url")

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

function expectSixbError(error: unknown, code: SixbErrorCode) {
  expect(isSixbError(error)).toBe(true)
  if (!isSixbError(error)) throw new Error("Expected a coded Sixb error.")
  expect(error.code).toBe(code)
  return error
}

type HarnessOptions = Pick<
  ConnectorServiceOptions,
  | "accountSelectionTtlMs"
  | "credentialMutationLeaseMs"
  | "credentialMutationTimeoutMs"
  | "refreshSkewMs"
> & { readonly systemStorageClock?: boolean }

function createHarness(options: HarnessOptions = {}) {
  let now = new Date("2026-08-19T12:00:00.000Z")
  let exchangeCount = 0
  let refreshCount = 0
  let revokeCount = 0
  let refreshError: Error | undefined
  let revokeError: Error | undefined
  let revokeAfterEffectError: Error | undefined
  let exchangeGate: Promise<void> | undefined
  let discoverGate: Promise<void> | undefined
  let refreshGate: Promise<void> | undefined
  let revokeGate: Promise<void> | undefined
  let providerRevoked = false
  const exchangedVerifiers: string[] = []

  const connector = defineConnector("social", {
    type: "fake-oauth",
    authentication: {
      type: "oauth2",
      authorizationUrl(_context, input) {
        const url = new URL("https://provider.test/oauth/authorize")
        url.searchParams.set("state", input.state)
        url.searchParams.set("code_challenge", input.codeChallenge)
        url.searchParams.set("code_challenge_method", input.codeChallengeMethod)
        return url
      },
      async exchangeCode(_context, input) {
        await exchangeGate
        exchangedVerifiers.push(input.codeVerifier)
        exchangeCount += 1
        return {
          accessToken: `access-secret-${exchangeCount}`,
          refreshToken: `refresh-secret-${exchangeCount}`,
          tokenType: "Bearer",
          scopes: ["accounts.read"],
          expiresAt: new Date(now.getTime() + 30_000),
        }
      },
      async refresh(_context, credentials) {
        refreshCount += 1
        await refreshGate
        if (refreshError) throw refreshError
        return {
          accessToken: `rotated-access-${refreshCount}`,
          refreshToken: `rotated-refresh-${refreshCount}`,
          tokenType: credentials.tokenType,
          scopes: credentials.scopes,
          expiresAt: new Date(now.getTime() + 60 * 60_000),
        }
      },
      async revoke() {
        revokeCount += 1
        await revokeGate
        if (providerRevoked) return
        if (revokeError) throw revokeError
        providerRevoked = true
        if (revokeAfterEffectError) throw revokeAfterEffectError
      },
    },
    async discoverAccounts() {
      await discoverGate
      return [
        { id: "account-a", label: "Account A" },
        { id: "account-b", label: "Account B" },
      ]
    },
    connect(context) {
      return {
        accountId: context.account.id,
        aborted: () => context.signal.aborted,
        token: () => context.tokenSource.get(),
        invalidate: () => context.tokenSource.invalidate(),
      }
    },
  })

  const storage = new InMemoryConnectorConnectionStorage({
    now: options.systemStorageClock ? undefined : () => new Date(now),
  })
  const protector = createConnectorCredentialProtectorFromKey(encryptionKey)
  const service = new ConnectorService("project", [connector], {
    storage,
    credentialProtector: protector,
    now: () => new Date(now),
    accountSelectionTtlMs: options.accountSelectionTtlMs,
    credentialMutationLeaseMs: options.credentialMutationLeaseMs,
    credentialMutationTimeoutMs: options.credentialMutationTimeoutMs,
    refreshSkewMs: options.refreshSkewMs,
  })

  return {
    connector,
    storage,
    protector,
    service,
    setNow(value: Date) {
      now = new Date(value)
    },
    setRefreshError(value: Error | undefined) {
      refreshError = value
    },
    setRevokeError(value: Error | undefined) {
      revokeError = value
    },
    setRevokeAfterEffectError(value: Error | undefined) {
      revokeAfterEffectError = value
    },
    setExchangeGate(value: Promise<void> | undefined) {
      exchangeGate = value
    },
    setDiscoverGate(value: Promise<void> | undefined) {
      discoverGate = value
    },
    setRefreshGate(value: Promise<void> | undefined) {
      refreshGate = value
    },
    setRevokeGate(value: Promise<void> | undefined) {
      revokeGate = value
    },
    now: () => new Date(now),
    counts: () => ({ exchangeCount, refreshCount, revokeCount }),
    exchangedVerifiers,
  }
}

function managementRuntime(
  sessionId = "session-a",
  options: { readonly principalId?: string; readonly manage?: boolean } = {}
) {
  const grants =
    options.manage === false
      ? emptyGrantIndex()
      : { ...emptyGrantIndex(), "manage:connector": new Set(["social"]) }
  const context: AuthorizationContext = {
    principal: { type: "user", id: options.principalId ?? "user-a" },
    sessionId,
    groupIds: [],
    roleIds: [],
    grants,
  }
  const scope = createPrincipalRequestScope({
    projectId: "project",
    requestId: `request-${sessionId}`,
    correlationId: `correlation-${sessionId}`,
    context,
    credential: { type: "session", id: sessionId },
  })
  return { runtimeAuthorization: scope.authorization, authorization: context }
}

function accessTokenRuntime(accessTokenId: string) {
  const context: AuthorizationContext = {
    principal: { type: "serviceAccount", id: "service-a" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "manage:connector": new Set(["social"]) },
  }
  const scope = createPrincipalRequestScope({
    projectId: "project",
    requestId: `request-${accessTokenId}`,
    correlationId: `correlation-${accessTokenId}`,
    context,
    credential: { type: "accessToken", id: accessTokenId },
  })
  return { runtimeAuthorization: scope.authorization, authorization: context }
}

async function startAuthorization(harness: ReturnType<typeof createHarness>, slot = "social") {
  const started = await harness.service.startAuthorization(managementRuntime(), harness.connector, {
    owner: projectOwner,
    slot,
    redirectUri: callbackUrl,
  })
  const url = new URL(started.authorizationUrl)
  return {
    url,
    state: url.searchParams.get("state")!,
    complete: () =>
      harness.service.completeAuthorization(managementRuntime(), harness.connector, {
        state: url.searchParams.get("state")!,
        code: "authorization-code",
        redirectUri: callbackUrl,
      }),
  }
}

async function authorize(harness: ReturnType<typeof createHarness>, slot = "social") {
  return (await startAuthorization(harness, slot)).complete()
}

function serializedSnapshot(storage: InMemoryConnectorConnectionStorage): string {
  const snapshot = storage.snapshot()
  return JSON.stringify({
    attempts: [...snapshot.attempts.values()],
    authorizations: [...snapshot.authorizations.values()],
    connections: [...snapshot.connections.values()],
  })
}

describe("connector OAuth lifecycle", () => {
  test("binds a short-lived, one-use state to session, callback and PKCE S256", async () => {
    const harness = createHarness()
    const started = await startAuthorization(harness)
    const challenge = started.url.searchParams.get("code_challenge")

    await expect(
      harness.service.completeAuthorization(
        managementRuntime("another-session"),
        harness.connector,
        {
          state: started.state,
          code: "authorization-code",
          redirectUri: callbackUrl,
        }
      )
    ).rejects.toThrow("invalid, expired, or already used")

    const completed = await started.complete()
    const verifier = harness.exchangedVerifiers[0]
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
    expect(completed.accounts.map((account) => account.id)).toEqual(["account-a", "account-b"])

    await expect(started.complete()).rejects.toThrow("invalid, expired, or already used")
  })

  test("rejects expired attempts before exchanging a code", async () => {
    const harness = createHarness()
    const started = await startAuthorization(harness)
    harness.setNow(new Date("2026-08-19T12:11:00.000Z"))

    const error = expectSixbError(
      await rejectionOf(started.complete()),
      "connector.authorization_invalid"
    )
    expect(error.cause).toBeInstanceOf(Error)
    expect(harness.counts().exchangeCount).toBe(0)
  })

  test("binds service-account attempts to the exact access token", async () => {
    const harness = createHarness()
    const started = await harness.service.startAuthorization(
      accessTokenRuntime("token-a"),
      harness.connector,
      { owner: projectOwner, slot: "social", redirectUri: callbackUrl }
    )
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const callback = { state, code: "authorization-code", redirectUri: callbackUrl }

    await expect(
      harness.service.completeAuthorization(
        accessTokenRuntime("token-b"),
        harness.connector,
        callback
      )
    ).rejects.toThrow("invalid, expired, or already used")
    await expect(
      harness.service.completeAuthorization(
        accessTokenRuntime("token-a"),
        harness.connector,
        callback
      )
    ).resolves.toMatchObject({ accounts: [{ id: "account-a" }, { id: "account-b" }] })
  })

  test("requires can.manage for the connector definition", async () => {
    const harness = createHarness()
    await expect(
      harness.service.startAuthorization(
        managementRuntime("session-a", { manage: false }),
        harness.connector,
        {
          owner: projectOwner,
          slot: "social",
          redirectUri: callbackUrl,
        }
      )
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  test("rejects authorization URLs that drop framework-owned state or PKCE", async () => {
    const harness = createHarness()
    const connector = defineConnector("social", {
      ...harness.connector.adapter,
      authentication: {
        ...harness.connector.adapter.authentication,
        authorizationUrl() {
          return "https://provider.test/oauth/authorize"
        },
      },
    })
    const service = new ConnectorService("project", [connector], {
      storage: harness.storage,
      credentialProtector: harness.protector,
    })

    await expect(
      service.startAuthorization(managementRuntime(), connector, {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
      })
    ).rejects.toThrow("preserve the framework-provided state and PKCE S256 parameters")
    expect(harness.storage.snapshot().attempts.size).toBe(0)
  })

  test("never persists OAuth or PKCE secrets in plaintext", async () => {
    const harness = createHarness()
    const started = await startAuthorization(harness)
    expect(serializedSnapshot(harness.storage)).not.toContain(started.state)

    await started.complete()
    const persisted = serializedSnapshot(harness.storage)
    expect(persisted).not.toContain("access-secret-1")
    expect(persisted).not.toContain("refresh-secret-1")
    expect(persisted).not.toContain(harness.exchangedVerifiers[0])
  })

  test("bounds initial account discovery while retaining pending credentials", async () => {
    const harness = createHarness({ credentialMutationTimeoutMs: 20 })
    harness.setDiscoverGate(new Promise<void>(() => {}))
    const started = await startAuthorization(harness)

    const error = expectSixbError(
      await rejectionOf(started.complete()),
      "connector.provider_failed"
    )
    expect(error.retryable).toBe(false)
    const pending = [...harness.storage.snapshot().authorizations.values()]
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ status: "pending_selection", accounts: [] })
  })

  test("expires unselected authorizations before they can create a connection", async () => {
    const harness = createHarness({ accountSelectionTtlMs: 1_000 })
    const authorization = await authorize(harness)
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "pending_selection"
    )

    harness.setNow(new Date("2026-08-19T12:00:01.000Z"))
    expectSixbError(
      await rejectionOf(
        harness.service.selectAccount(managementRuntime(), harness.connector, {
          authorizationId: authorization.authorizationId,
          accountId: "account-a",
          owner: projectOwner,
          slot: "social",
        })
      ),
      "connector.operation_conflict"
    )
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revocation_pending"
    )

    await harness.service.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revoked"
    )
  })
})

describe("connector connection lifecycle", () => {
  test("shares one authorization, disconnects one connection, and revokes all remaining", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    const first = await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "ads",
    })
    expect(
      await harness.storage.listConnectionsByAuthorization(authorization.authorizationId)
    ).toHaveLength(2)

    await harness.service.disconnect(managementRuntime(), harness.connector, first.id)
    expect(
      await harness.storage.listConnectionsByAuthorization(authorization.authorizationId)
    ).toHaveLength(1)
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "active"
    )

    const revoked = await harness.service.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    expect(revoked.affectedConnections.map((connection) => connection.slot)).toEqual(["ads"])
    expect(revoked.affectedConnections[0].status).toBe("revoked")
    expect(
      await harness.storage.listConnectionsByAuthorization(authorization.authorizationId)
    ).toHaveLength(0)
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revoked"
    )
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("keeps provider revocation pending when credentials cannot be opened", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const decryptionError = new Error("missing decryption key")
    const service = new ConnectorService("project", [harness.connector], {
      storage: harness.storage,
      credentialProtector: {
        seal: (plaintext, credentialContext) =>
          harness.protector.seal(plaintext, credentialContext),
        open: async () => {
          throw decryptionError
        },
      },
    })

    const error = expectSixbError(
      await rejectionOf(
        service.revokeAuthorization(
          managementRuntime(),
          harness.connector,
          authorization.authorizationId
        )
      ),
      "connector.credentials_unavailable"
    )
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(decryptionError)
    expect(error.message).not.toContain("missing decryption key")
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revocation_pending"
    )
    expect(
      await harness.storage.listConnectionsByAuthorization(authorization.authorizationId)
    ).toEqual([])

    await harness.service.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revoked"
    )
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("retries provider revocation without reconnecting local usages", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const providerError = new Error("temporary provider failure")
    harness.setRevokeError(providerError)

    const error = expectSixbError(
      await rejectionOf(
        harness.service.revokeAuthorization(
          managementRuntime(),
          harness.connector,
          authorization.authorizationId
        )
      ),
      "connector.revocation_pending"
    )
    expect(error.retryable).toBe(true)
    expect(error.cause).toBe(providerError)
    expect(error.message).not.toContain("temporary provider failure")
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revocation_pending"
    )
    expect(
      await harness.storage.listConnectionsByAuthorization(authorization.authorizationId)
    ).toEqual([])

    harness.setRevokeError(undefined)
    await harness.service.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revoked"
    )
    expect(harness.counts().revokeCount).toBe(2)
  })

  test("converges when a retried provider revocation was already applied", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    harness.setRevokeAfterEffectError(new Error("provider response was lost"))

    expectSixbError(
      await rejectionOf(
        harness.service.revokeAuthorization(
          managementRuntime(),
          harness.connector,
          authorization.authorizationId
        )
      ),
      "connector.revocation_pending"
    )
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revocation_pending"
    )

    await harness.service.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revoked"
    )
    expect(harness.counts().revokeCount).toBe(2)
  })

  test("coalesces concurrent revocation attempts across service instances", async () => {
    const harness = createHarness()
    let releaseRevoke!: () => void
    harness.setRevokeGate(new Promise<void>((resolve) => (releaseRevoke = resolve)))
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
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

    const first = harness.service.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    await Bun.sleep(0)
    const second = secondService.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    await Bun.sleep(10)
    expect(harness.counts().revokeCount).toBe(1)
    releaseRevoke()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(harness.counts().revokeCount).toBe(1)
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revoked"
    )
  })

  test("preserves connection ids and requires explicit account replacement", async () => {
    const harness = createHarness()
    const firstAuthorization = await authorize(harness)
    const first = await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: firstAuthorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const secondAuthorization = await authorize(harness)
    const reauthorized = await harness.service.selectAccount(
      managementRuntime(),
      harness.connector,
      {
        authorizationId: secondAuthorization.authorizationId,
        accountId: "account-a",
        owner: projectOwner,
        slot: "social",
      }
    )
    expect(reauthorized.id).toBe(first.id)

    await expect(
      harness.service.selectAccount(managementRuntime(), harness.connector, {
        authorizationId: secondAuthorization.authorizationId,
        accountId: "account-b",
        owner: projectOwner,
        slot: "social",
      })
    ).rejects.toThrow("explicit replacement is required")

    const replaced = await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: secondAuthorization.authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "social",
      replace: true,
    })
    expect(replaced.id).toBe(first.id)
    expect(replaced.account.id).toBe("account-b")
  })

  test("reauthorizes every connection sharing a grant explicitly and atomically", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    const first = await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const second = await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "ads",
    })

    const revisionBefore = (await harness.storage.getAuthorization(authorization.authorizationId))!
      .revision
    const started = await harness.service.startAuthorization(
      managementRuntime(),
      harness.connector,
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
    const completed = await harness.service.completeAuthorization(
      managementRuntime(),
      harness.connector,
      { state, code: "authorization-code", redirectUri: callbackUrl }
    )

    expect(completed.authorizationId).toBe(authorization.authorizationId)
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.revision).toBe(
      revisionBefore + 1
    )
    expect(
      (await harness.storage.listConnectionsByAuthorization(authorization.authorizationId))
        .map((connection) => connection.id)
        .sort()
    ).toEqual([first.id, second.id].sort())
  })

  test("rejects an older reauthorization callback after a newer attempt completes", async () => {
    const harness = createHarness({ refreshSkewMs: 0 })
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const startReauthorization = () =>
      harness.service.startAuthorization(managementRuntime(), harness.connector, {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorization.authorizationId,
      })
    const older = await startReauthorization()
    const newer = await startReauthorization()

    await harness.service.completeAuthorization(managementRuntime(), harness.connector, {
      state: new URL(newer.authorizationUrl).searchParams.get("state")!,
      code: "newer-authorization-code",
      redirectUri: callbackUrl,
    })
    const completedRevision = (
      await harness.storage.getAuthorization(authorization.authorizationId)
    )?.revision

    const error = expectSixbError(
      await rejectionOf(
        harness.service.completeAuthorization(managementRuntime(), harness.connector, {
          state: new URL(older.authorizationUrl).searchParams.get("state")!,
          code: "older-authorization-code",
          redirectUri: callbackUrl,
        })
      ),
      "connector.authorization_invalid"
    )
    expect(error.retryable).toBe(false)
    expect(harness.counts().exchangeCount).toBe(2)
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.revision).toBe(
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
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const started = await harness.service.startAuthorization(
      managementRuntime(),
      harness.connector,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: authorization.authorizationId,
      }
    )
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "ads",
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!

    await expect(
      harness.service.completeAuthorization(managementRuntime(), harness.connector, {
        state,
        code: "authorization-code",
        redirectUri: callbackUrl,
      })
    ).rejects.toThrow("changed; restart reauthorization")
    expect(harness.counts().exchangeCount).toBe(1)
  })

  test("bounds account discovery and keeps reauthorized credentials staged", async () => {
    const harness = createHarness({ credentialMutationTimeoutMs: 20 })
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const started = await harness.service.startAuthorization(
      managementRuntime(),
      harness.connector,
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
        harness.service.completeAuthorization(managementRuntime(), harness.connector, {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: "authorization-code",
          redirectUri: callbackUrl,
        })
      ),
      "connector.provider_failed"
    )
    expect(
      (await harness.storage.getAuthorization(authorization.authorizationId))?.credentialMutation
        ?.phase
    ).toBe("result_staged")
    expect(serializedSnapshot(harness.storage)).not.toContain("access-secret-2")

    harness.setDiscoverGate(undefined)
    await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const recovered = await harness.storage.getAuthorization(authorization.authorizationId)
    expect(recovered?.credentialMutation).toBeUndefined()
    expect(recovered?.status).toBe("active")
    expect(harness.counts().exchangeCount).toBe(2)
  })
})

describe("connector credential refresh", () => {
  test("coordinates concurrent OAuth token refresh by authorization", async () => {
    const harness = createHarness()
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
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
    const revisionBefore = (await harness.storage.getAuthorization(authorization.authorizationId))!
      .revision
    const tokens = Promise.all([first.token(), second.token()])
    await Bun.sleep(0)
    expect(harness.counts().refreshCount).toBe(1)
    releaseRefresh()

    expect(await tokens).toEqual([
      { accessToken: "rotated-access-1", tokenType: "Bearer" },
      { accessToken: "rotated-access-1", tokenType: "Bearer" },
    ])
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.revision).toBe(
      revisionBefore + 1
    )
  })

  test("rejects reauthorization made stale by a concurrent refresh", async () => {
    const harness = createHarness()
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const management = new ConnectorService("project", [harness.connector], {
      storage: harness.storage,
      credentialProtector: harness.protector,
      now: harness.now,
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const refreshing = client.token()
    await Bun.sleep(0)

    const started = await management.startAuthorization(managementRuntime(), harness.connector, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
      reauthorizationId: authorization.authorizationId,
    })
    const reauthorizing = management.completeAuthorization(managementRuntime(), harness.connector, {
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "authorization-code",
      redirectUri: callbackUrl,
    })
    const reauthorizationFailure = rejectionOf(reauthorizing)
    await Bun.sleep(10)
    expect(harness.counts().exchangeCount).toBe(1)

    releaseRefresh()
    await refreshing
    expectSixbError(await reauthorizationFailure, "connector.authorization_invalid")
    expect(harness.counts()).toMatchObject({ refreshCount: 1, exchangeCount: 1 })
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "active"
    )
  })

  test("serializes refresh and provider revocation", async () => {
    const harness = createHarness()
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const management = new ConnectorService("project", [harness.connector], {
      storage: harness.storage,
      credentialProtector: harness.protector,
      now: harness.now,
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    const refreshing = client.token()
    await Bun.sleep(0)
    const revoking = management.revokeAuthorization(
      managementRuntime(),
      harness.connector,
      authorization.authorizationId
    )
    await Bun.sleep(10)
    expect(harness.counts().revokeCount).toBe(0)

    releaseRefresh()
    await refreshing
    await revoking
    expect(harness.counts()).toMatchObject({ refreshCount: 1, revokeCount: 1 })
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "revoked"
    )
  })

  test("renews a credential mutation lease during a slow provider refresh", async () => {
    const harness = createHarness({
      systemStorageClock: true,
      credentialMutationLeaseMs: 30,
      credentialMutationTimeoutMs: 500,
    })
    let releaseRefresh!: () => void
    harness.setRefreshGate(new Promise<void>((resolve) => (releaseRefresh = resolve)))
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
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
      credentialMutationTimeoutMs: 500,
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
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
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

  test("marks terminal refresh failures as needing reauthorization", async () => {
    const harness = createHarness()
    const providerError = new ConnectorOAuthError("terminal", "invalid_grant")
    harness.setRefreshError(providerError)
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
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
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "needs_reauthorization"
    )
    await expect(client.token()).rejects.toThrow("require reauthorization")
    expect(harness.counts().refreshCount).toBe(1)
  })

  test("releases retryable refresh failures without poisoning the authorization", async () => {
    const harness = createHarness()
    const providerError = new ConnectorOAuthError("retryable", "provider secret")
    harness.setRefreshError(providerError)
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
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
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "active"
    )
    expect(
      (await harness.storage.getAuthorization(authorization.authorizationId))?.credentialMutation
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
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const client = await harness.service.connectConnection(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    Object.defineProperty(harness.storage, "releaseCredentialMutation", {
      value: async () => {
        throw recoveryError
      },
    })

    const error = expectSixbError(await rejectionOf(client.token()), "internal.unexpected")
    expect(error.message).not.toContain("provider secret")
    expect(error.message).not.toContain("storage secret")
    expect(error.cause).toBeInstanceOf(AggregateError)
    if (!(error.cause instanceof AggregateError)) throw new Error("Expected aggregated causes.")
    expect(error.cause.errors).toEqual([providerError, recoveryError])
  })

  test("fails closed when a refresh outcome is ambiguous", async () => {
    const harness = createHarness()
    const providerError = new Error("connection reset")
    harness.setRefreshError(providerError)
    const authorization = await authorize(harness)
    await harness.service.selectAccount(managementRuntime(), harness.connector, {
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
    expect((await harness.storage.getAuthorization(authorization.authorizationId))?.status).toBe(
      "needs_reauthorization"
    )
  })
})

describe("connector connection execution boundary", () => {
  test("allows trusted primitives and denies agents", async () => {
    const harness = createHarness()
    const dependencies = createTestRuntimeDeps()
    const management = new ConnectorService("default", [harness.connector], {
      storage: dependencies.storage.connectorConnections,
      credentialProtector: harness.protector,
    })
    const defaultRuntime = (() => {
      const grants = { ...emptyGrantIndex(), "manage:connector": new Set(["social"]) }
      const context: AuthorizationContext = {
        principal: { type: "user", id: "user-a" },
        sessionId: "session-a",
        groupIds: [],
        roleIds: [],
        grants,
      }
      const scope = createPrincipalRequestScope({
        projectId: "default",
        requestId: "request-a",
        correlationId: "correlation-a",
        context,
        credential: { type: "session", id: "session-a" },
      })
      return { runtimeAuthorization: scope.authorization, authorization: context }
    })()
    const started = await management.startAuthorization(defaultRuntime, harness.connector, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const authorization = await management.completeAuthorization(
      defaultRuntime,
      harness.connector,
      {
        state,
        code: "authorization-code",
        redirectUri: callbackUrl,
      }
    )
    await management.selectAccount(defaultRuntime, harness.connector, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })

    const host = new SixbHost({
      ontology: [],
      connectors: [harness.connector],
      connectorConnections: { encryptionKey },
      ...dependencies,
    })
    const trusted = host.withScope(
      createTrustedPrimitiveScope({
        projectId: "default",
        primitive: { kind: "action", id: "publish", runId: "run-a" },
        source: { type: "queue", queue: "actions", jobId: "job-a" },
      })
    )
    const first = await trusted.connector(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    expect(first.accountId).toBe("account-a")
    expect(first.aborted()).toBe(false)

    await host.closeConnectors()
    expect(first.aborted()).toBe(true)
    const reconnected = await trusted.connector(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    expect(reconnected.aborted()).toBe(false)

    const agentContext: AuthorizationContext = {
      principal: { type: "serviceAccount", id: "agent-account" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    }
    const agent = host.withScope(
      createAgentScope({
        projectId: "default",
        agentId: "publisher",
        runId: "agent-run-a",
        context: agentContext,
        source: { type: "queue", queue: "agents", jobId: "agent-job-a" },
      })
    )
    expect(() =>
      agent.connector(harness.connector, { owner: projectOwner, slot: "social" })
    ).toThrow(AuthorizationError)
  })
})

describe("connector connection startup validation", () => {
  test("requires connection storage and explicit protection for durable providers", () => {
    const harness = createHarness()
    expect(() => new ConnectorService("project", [harness.connector])).toThrow(
      "storage.connectorConnections"
    )
    expect(
      () =>
        new ConnectorService("project", [harness.connector], {
          storage: new InMemoryConnectorConnectionStorage(),
        })
    ).not.toThrow()

    const durable =
      new InMemoryConnectorConnectionStorage() as InMemoryConnectorConnectionStorage & {
        durability: "durable"
      }
    Object.defineProperty(durable, "durability", { value: "durable" })
    expect(
      () => new ConnectorService("project", [harness.connector], { storage: durable })
    ).toThrow("connectorConnections.encryptionKey")
  })

  test("validates encryption only when OAuth connections need it", () => {
    const harness = createHarness()
    expect(
      () =>
        new SixbHost<readonly []>({
          ontology: [],
          connectors: [harness.connector],
          connectorConnections: {
            encryptionKey: Buffer.from(new Uint8Array(31)).toString("base64url"),
          },
          ...createTestRuntimeDeps(),
        })
    ).toThrow("exactly 32 random bytes")

    const staticConnector = defineConnector("static", {
      type: "static",
      connect() {
        return {}
      },
    })
    expect(
      () =>
        new SixbHost<readonly []>({
          ontology: [],
          connectors: [staticConnector],
          connectorConnections: { encryptionKey: "unused" },
          ...createTestRuntimeDeps(),
        })
    ).not.toThrow()
  })

  test("rejects OAuth sync and webhook surfaces explicitly", () => {
    const harness = createHarness()
    const dataset = defineDataset("accounts", { schema: [col("id", "string")] })
    const staticConnector = defineConnector("static", {
      type: "static",
      connect() {
        return {}
      },
    })
    const sync = defineSync("accounts")
      .from(staticConnector)
      .read(() => [])
      .intoDataset(dataset)
    const oauthSync = { ...sync, connector: harness.connector } as unknown as SyncDefinition

    expect(
      () =>
        new SixbHost<readonly []>({
          ontology: [],
          connectors: [harness.connector],
          datasets: [dataset],
          syncs: [oauthSync],
          connectorConnections: { encryptionKey },
          ...createTestRuntimeDeps(),
        })
    ).toThrow("cannot use OAuth connector")

    Object.defineProperty(harness.connector.adapter, "webhooks", { value: [] })
    expect(
      () =>
        new SixbHost<readonly []>({
          ontology: [],
          connectors: [harness.connector],
          connectorConnections: { encryptionKey },
          ...createTestRuntimeDeps(),
        })
    ).toThrow("cannot register webhooks")
  })
})
