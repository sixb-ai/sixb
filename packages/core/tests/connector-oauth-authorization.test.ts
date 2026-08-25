import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { AuthorizationError, defineConnector, SixbHost } from "../src"
import { ConnectorService } from "../src/connectors/service"
import { getConnectorConnectionsRuntime } from "../src/runtime/internal"
import {
  accessTokenCommand,
  authorize,
  callbackUrl,
  connectionSnapshot,
  createHarness,
  encryptionKey,
  expectSixbError,
  getAuthorization,
  managementCommand,
  managementScope,
  projectOwner,
  rejectionOf,
  requireConnectionProcess,
  seedAuthorizationAttempt,
  seedConnectorActors,
  serializedSnapshot,
  startAuthorization,
} from "./connector-connections.fixture"
import { createTestRuntimeDeps } from "./test-runtime-deps"

describe("connector OAuth lifecycle", () => {
  test("persists the initiating execution and stores only its id on the attempt", async () => {
    const harness = createHarness()
    const command = managementCommand()

    await harness.process.startAuthorization(command, harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
    })

    const execution = await harness.storage.executions.getById({
      projectId: "project",
      id: command.execution.id,
    })
    expect(execution).not.toBeNull()
    if (!execution) throw new Error("Expected the initiating execution to be persisted.")
    const { createdAt: _createdAt, ...persistedInput } = execution
    expect(persistedInput).toEqual(command.execution)

    const attempts = [...connectionSnapshot(harness.storage).attempts.values()]
    expect(attempts).toHaveLength(1)
    expect(attempts[0].initiatedByExecutionId).toBe(command.execution.id)
    expect(attempts[0]).not.toHaveProperty("authorizedBy")
    expect(attempts[0]).not.toHaveProperty("credential")
  })

  test("binds a short-lived, one-use state to principal, session, callback and PKCE", async () => {
    const harness = createHarness()
    const started = await startAuthorization(harness)
    const challenge = started.url.searchParams.get("code_challenge")

    expectSixbError(
      await rejectionOf(
        harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
          state: "malformed",
          code: "authorization-code",
          redirectUri: callbackUrl,
        })
      ),
      "connector.authorization_invalid"
    )

    await expect(
      harness.process.completeAuthorization(
        managementCommand("another-session"),
        harness.connector.id,
        {
          state: started.state,
          code: "authorization-code",
          redirectUri: callbackUrl,
        }
      )
    ).rejects.toThrow("invalid, expired, or already used")
    expect(harness.counts().exchangeCount).toBe(0)
    expect(connectionSnapshot(harness.storage).attempts.size).toBe(1)

    await expect(
      harness.process.completeAuthorization(
        managementCommand("session-b", { principalId: "user-b" }),
        harness.connector.id,
        {
          state: started.state,
          code: "authorization-code",
          redirectUri: callbackUrl,
        }
      )
    ).rejects.toThrow("invalid, expired, or already used")
    expect(harness.counts().exchangeCount).toBe(0)
    expect(connectionSnapshot(harness.storage).attempts.size).toBe(1)

    const completed = await started.complete()
    const verifier = harness.exchangedVerifiers[0]
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
    expect(completed.accounts.map((account) => account.id)).toEqual(["account-a", "account-b"])

    await expect(started.complete()).rejects.toThrow("invalid, expired, or already used")
  })

  test("rejects missing or invalid initiating executions before calling the provider", async () => {
    const harness = createHarness()
    await harness.ready
    await harness.storage.executions.create({
      id: "exec_invalid_initiator",
      projectId: "project",
      executor: { type: "request", requestId: "request-invalid" },
      source: { type: "http", requestId: "request-invalid" },
      correlationId: "correlation-invalid",
      authorizationRef: { type: "disabled" },
    })

    for (const attempt of [
      { id: "cat_missing_initiator", executionId: "exec_missing_initiator" },
      { id: "cat_invalid_initiator", executionId: "exec_invalid_initiator" },
    ]) {
      const state = await seedAuthorizationAttempt(harness, {
        id: attempt.id,
        initiatedByExecutionId: attempt.executionId,
      })
      await expect(
        harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
          state,
          code: "authorization-code",
          redirectUri: callbackUrl,
        })
      ).rejects.toThrow("invalid, expired, or already used")
      expect(connectionSnapshot(harness.storage).attempts.has(attempt.id)).toBe(true)
    }
    expect(harness.counts().exchangeCount).toBe(0)
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
    expect(connectionSnapshot(harness.storage).attempts.size).toBe(0)
    expect(harness.counts().exchangeCount).toBe(0)
  })

  test("binds service-account attempts to the exact access token", async () => {
    const harness = createHarness()
    const started = await harness.process.startAuthorization(
      accessTokenCommand("token-a"),
      harness.connector.id,
      { owner: projectOwner, slot: "social", redirectUri: callbackUrl }
    )
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const callback = { state, code: "authorization-code", redirectUri: callbackUrl }

    await expect(
      harness.process.completeAuthorization(
        accessTokenCommand("token-b"),
        harness.connector.id,
        callback
      )
    ).rejects.toThrow("invalid, expired, or already used")
    await expect(
      harness.process.completeAuthorization(
        accessTokenCommand("token-a"),
        harness.connector.id,
        callback
      )
    ).resolves.toMatchObject({ accounts: [{ id: "account-a" }, { id: "account-b" }] })
  })

  test("runs the OAuth flow through the execution-bound internal facade", async () => {
    const harness = createHarness()
    const dependencies = createTestRuntimeDeps()
    await seedConnectorActors(dependencies.storage, "default", new Date("2026-08-19T12:00:00.000Z"))
    const host = new SixbHost({
      ontology: [],
      connectors: [harness.connector],
      connectorConnections: { encryptionKey },
      ...dependencies,
    })
    const { scope } = managementScope("session-a", { projectId: "default" })
    const connections = getConnectorConnectionsRuntime(host.withScope(scope))

    const started = await connections.startAuthorization(harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const attemptId = state.slice(0, state.indexOf("."))
    const attempt = connectionSnapshot(dependencies.storage).attempts.get(attemptId)
    expect(attempt?.initiatedByExecutionId).toBe(scope.execution.id)
    await expect(
      dependencies.storage.executions.getById({
        projectId: "default",
        id: scope.execution.id,
      })
    ).resolves.toMatchObject({ id: scope.execution.id })

    await expect(
      connections.completeAuthorization(harness.connector.id, {
        state,
        code: "authorization-code",
        redirectUri: callbackUrl,
      })
    ).resolves.toMatchObject({ accounts: [{ id: "account-a" }, { id: "account-b" }] })
  })

  test("requires can.manage for the connector definition", async () => {
    const harness = createHarness()
    const dependencies = createTestRuntimeDeps()
    const host = new SixbHost({
      ontology: [],
      connectors: [harness.connector],
      connectorConnections: { encryptionKey },
      ...dependencies,
    })
    const { scope } = managementScope("session-a", { manage: false, projectId: "default" })
    const connections = getConnectorConnectionsRuntime(host.withScope(scope))

    expect(() =>
      connections.startAuthorization(harness.connector.id, {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
      })
    ).toThrow(AuthorizationError)
    expect(connectionSnapshot(dependencies.storage).attempts.size).toBe(0)
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
    const process = requireConnectionProcess(
      new ConnectorService("project", [connector], {
        storage: harness.storage,
        credentialProtector: harness.protector,
      })
    )

    await expect(
      process.startAuthorization(managementCommand(), connector.id, {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
      })
    ).rejects.toThrow("preserve the framework-provided state and PKCE S256 parameters")
    expect(connectionSnapshot(harness.storage).attempts.size).toBe(0)
  })

  test("bounds provider authorization URL generation before persisting an attempt", async () => {
    const harness = createHarness({ providerOperationTimeoutMs: 20 })
    harness.setAuthorizationUrlGate(new Promise<void>(() => {}))

    expectSixbError(
      await rejectionOf(
        harness.process.startAuthorization(managementCommand(), harness.connector.id, {
          owner: projectOwner,
          slot: "social",
          redirectUri: callbackUrl,
        })
      ),
      "connector.provider_unavailable"
    )
    expect(connectionSnapshot(harness.storage).attempts.size).toBe(0)
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

  test("revokes unused credentials when initial account discovery fails", async () => {
    const harness = createHarness({ providerOperationTimeoutMs: 20 })
    harness.setDiscoverGate(new Promise<void>(() => {}))
    const started = await startAuthorization(harness)

    const error = expectSixbError(
      await rejectionOf(started.complete()),
      "connector.provider_failed"
    )
    expect(error.retryable).toBe(false)
    const authorizations = [...connectionSnapshot(harness.storage).authorizations.values()]
    expect(authorizations).toHaveLength(1)
    expect(authorizations[0]).toMatchObject({
      status: "revoked",
      credentials: undefined,
      accounts: [],
      scopes: [],
    })
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("rejects reauthorization before an account was selected", async () => {
    const harness = createHarness()
    const authorization = await authorize(harness)
    const attemptsBefore = connectionSnapshot(harness.storage).attempts.size

    const error = expectSixbError(
      await rejectionOf(
        harness.process.startAuthorization(managementCommand(), harness.connector.id, {
          owner: projectOwner,
          slot: "social",
          redirectUri: callbackUrl,
          reauthorizationId: authorization.authorizationId,
        })
      ),
      "connector.authorization_invalid"
    )
    expect(error.message).toContain("select an account")
    expect(connectionSnapshot(harness.storage).attempts.size).toBe(attemptsBefore)
  })

  test("expires unselected authorizations before they can create a connection", async () => {
    const harness = createHarness({ accountSelectionTtlMs: 1_000 })
    const authorization = await authorize(harness)
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("pending_selection")

    harness.setNow(new Date("2026-08-19T12:00:01.000Z"))
    expectSixbError(
      await rejectionOf(
        harness.process.selectAccount(managementCommand(), harness.connector.id, {
          authorizationId: authorization.authorizationId,
          accountId: "account-a",
          owner: projectOwner,
          slot: "social",
        })
      ),
      "connector.operation_conflict"
    )
    expect(
      (await getAuthorization(harness.connectionStorage, authorization.authorizationId))?.status
    ).toBe("revoked")

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
})
