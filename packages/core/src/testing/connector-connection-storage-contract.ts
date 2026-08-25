import { describe, expect, test } from "bun:test"
import type {
  ClaimConnectorCredentialMutationResult,
  ConnectorAuthorizationRecord,
  ConnectorConnectionStorage,
  ConnectorCredentialMutationKind,
  CreateConnectorAuthorizationAttemptInput,
  CreateConnectorConnectionRunInput,
} from "../storage/connector-connections"
import type { CreateExecutionInput } from "../storage/executions"
import type { Storage } from "../storage/types"

export type ConnectorConnectionStorageContractStorage = Storage & {
  readonly connectorConnections: ConnectorConnectionStorage
}

export interface ConnectorConnectionStorageContractSuiteOptions<
  TStorage extends
    ConnectorConnectionStorageContractStorage = ConnectorConnectionStorageContractStorage,
> {
  /** Factory that produces one isolated complete storage provider for each test case. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Advances the storage-authoritative clock without relying on wall-clock sleeps. */
  readonly advanceTime: (storage: TStorage, durationMs: number) => void | Promise<void>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "project-a"
const connectorId = "social"
const credentials = {
  version: 1,
  algorithm: "A256GCM",
  nonce: "nonce",
  ciphertext: "ciphertext",
  tag: "tag",
} as const

/** Runs the atomicity, fencing, slot uniqueness and project-isolation storage contract. */
export function runConnectorConnectionStorageContractSuite<
  TStorage extends ConnectorConnectionStorageContractStorage,
>(label: string, options: ConnectorConnectionStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (
    body: (connections: TStorage["connectorConnections"], storage: TStorage) => Promise<void>
  ): Promise<void> => {
    const root = await options.createStorage()
    try {
      await body(root.connectorConnections, root)
    } finally {
      await options.teardown?.(root)
    }
  }

  describe(label, () => {
    test("binds one-use authorization attempts to their initiating execution", async () => {
      await withStorage(async (storage) => {
        const attempt = authorizationAttempt()
        await expect(storage.createAuthorizationAttempt(attempt)).resolves.toMatchObject({
          id: attempt.id,
          projectId,
          connectorId,
          initiatedByExecutionId: attempt.initiatedByExecutionId,
        })

        for (const mismatchedScope of [
          { projectId: "project-b" },
          { connectorId: "another-connector" },
        ]) {
          await expect(
            storage.consumeAuthorizationAttempt({
              ...authorizationAttemptConsumption(),
              ...mismatchedScope,
            })
          ).rejects.toThrow("invalid, expired, or already used")
        }

        await expect(
          storage.consumeAuthorizationAttempt(authorizationAttemptConsumption())
        ).resolves.toMatchObject({
          id: attempt.id,
          initiatedByExecutionId: attempt.initiatedByExecutionId,
        })
        await expect(
          storage.consumeAuthorizationAttempt(authorizationAttemptConsumption())
        ).rejects.toThrow("invalid, expired, or already used")
      })
    })

    test("expires authorization attempts from the authoritative storage clock", async () => {
      await withStorage(async (storage, root) => {
        const ttlMs = 60_000
        const attempt = await storage.createAuthorizationAttempt(authorizationAttempt({ ttlMs }))
        expect(attempt.expiresAt.getTime() - attempt.createdAt.getTime()).toBe(ttlMs)

        await options.advanceTime(root, ttlMs)

        await expect(
          storage.consumeAuthorizationAttempt(authorizationAttemptConsumption())
        ).rejects.toThrow("invalid, expired, or already used")
      })
    })

    test("returns detached authorization attempt records", async () => {
      await withStorage(async (storage) => {
        const created = await storage.createAuthorizationAttempt(authorizationAttempt())
        Object.assign(created.codeVerifier, { ciphertext: "mutated" })

        const consumed = await storage.consumeAuthorizationAttempt(
          authorizationAttemptConsumption()
        )
        expect(consumed.codeVerifier.ciphertext).toBe(credentials.ciphertext)
      })
    })

    test("commits and rolls back connection runs with their attempt and execution", async () => {
      await withStorage(async (storage, root) => {
        const committedExecution = requestExecution("execution-commit")
        const committedAttempt = authorizationAttempt({
          id: "attempt-commit",
          initiatedByExecutionId: committedExecution.id,
          connectionRunId: "run-commit",
          returnTo: "https://app.example.com/connectors",
          callbackBindingHash: "binding-commit",
        })
        const committedRun = connectionRun({
          id: "run-commit",
          initiatedByExecutionId: committedExecution.id,
          authorizationAttemptId: committedAttempt.id,
        })
        await root.transaction(
          async (tx) => {
            await tx.executions.create(committedExecution)
            const connections = requireTransactionConnections(tx)
            await connections.createConnectionRun(committedRun)
            await connections.createAuthorizationAttempt(committedAttempt)
          },
          { isolation: "serializable" }
        )

        expect(
          await root.executions.getById({ projectId, id: committedExecution.id })
        ).not.toBeNull()
        await expect(
          storage.getConnectionRun({ projectId, connectorId, runId: committedRun.id })
        ).resolves.toMatchObject({ id: committedRun.id })
        await expect(
          storage.consumeAuthorizationAttempt(authorizationAttemptConsumption(committedAttempt.id))
        ).resolves.toMatchObject({ id: committedAttempt.id })

        const rolledBackExecution = requestExecution("execution-rollback")
        const rolledBackAttempt = authorizationAttempt({
          id: "attempt-rollback",
          initiatedByExecutionId: rolledBackExecution.id,
          connectionRunId: "run-rollback",
          returnTo: "https://app.example.com/connectors",
          callbackBindingHash: "binding-rollback",
        })
        const rolledBackRun = connectionRun({
          id: "run-rollback",
          initiatedByExecutionId: rolledBackExecution.id,
          authorizationAttemptId: rolledBackAttempt.id,
        })
        const rollback = new Error("rollback connector authorization attempt")
        await expect(
          root.transaction(
            async (tx) => {
              await tx.executions.create(rolledBackExecution)
              const connections = requireTransactionConnections(tx)
              await connections.createConnectionRun(rolledBackRun)
              await connections.createAuthorizationAttempt(rolledBackAttempt)
              throw rollback
            },
            { isolation: "serializable" }
          )
        ).rejects.toBe(rollback)

        expect(await root.executions.getById({ projectId, id: rolledBackExecution.id })).toBeNull()
        await expect(
          storage.getConnectionRun({ projectId, connectorId, runId: rolledBackRun.id })
        ).resolves.toBeNull()
        await expect(
          storage.consumeAuthorizationAttempt(authorizationAttemptConsumption(rolledBackAttempt.id))
        ).rejects.toThrow("invalid, expired, or already used")
      })
    })

    test("claims a headless callback once with state and browser binding", async () => {
      await withStorage(async (storage) => {
        await storage.createConnectionRun(connectionRun())
        await storage.createAuthorizationAttempt(
          authorizationAttempt({
            connectionRunId: "run-a",
            returnTo: "https://app.example.com/connectors",
            callbackBindingHash: "binding-hash",
          })
        )

        await expect(
          storage.claimConnectionRunCallback({
            projectId,
            attemptId: "attempt-a",
            stateHash: "state-hash",
            callbackBindingHash: "wrong-binding",
            redirectUri: "https://example.com/oauth/callback",
          })
        ).resolves.toBeNull()

        const claimed = await storage.claimConnectionRunCallback({
          projectId,
          attemptId: "attempt-a",
          stateHash: "state-hash",
          callbackBindingHash: "binding-hash",
          redirectUri: "https://example.com/oauth/callback",
        })
        expect(claimed).toMatchObject({
          type: "claimed",
          run: { id: "run-a", status: "running" },
          attempt: { id: "attempt-a", connectionRunId: "run-a" },
          returnTo: "https://app.example.com/connectors",
        })
        expect(claimed && "returnTo" in claimed.run).toBe(false)
        await expect(
          storage.claimConnectionRunCallback({
            projectId,
            attemptId: "attempt-a",
            stateHash: "state-hash",
            callbackBindingHash: "binding-hash",
            redirectUri: "https://example.com/oauth/callback",
          })
        ).resolves.toBeNull()
      })
    })

    test("expires a waiting run and removes its protocol attempt lazily", async () => {
      await withStorage(async (storage, root) => {
        await storage.createConnectionRun(connectionRun())
        await storage.createAuthorizationAttempt(
          authorizationAttempt({
            connectionRunId: "run-a",
            returnTo: "https://app.example.com/connectors",
            callbackBindingHash: "binding-hash",
          })
        )
        await options.advanceTime(root, 60_000)

        await expect(
          storage.getConnectionRun({ projectId, connectorId, runId: "run-a" })
        ).resolves.toMatchObject({ status: "expired" })
        await expect(
          storage.claimConnectionRunCallback({
            projectId,
            attemptId: "attempt-a",
            stateHash: "state-hash",
            callbackBindingHash: "binding-hash",
            redirectUri: "https://example.com/oauth/callback",
          })
        ).resolves.toBeNull()
      })
    })

    test("keeps account selection atomic with its connection run", async () => {
      await withStorage(async (storage) => {
        const active = await createAuthorization(storage, "authorization-a", "account-a")
        await connect(storage, active, "connection-a", "account-a")
        const pending = await createAuthorization(storage, "authorization-b", "account-b")
        await createSelectionRun(storage, pending)

        await expect(
          storage.putConnectionFromRun({
            id: "connection-b",
            projectId,
            connectorId,
            runId: "run-a",
            account: { id: "account-b", label: "Account B" },
            replace: false,
          })
        ).rejects.toThrow("explicit replacement is required")
        expect(
          await storage.getConnectionRun({ projectId, connectorId, runId: "run-a" })
        ).toMatchObject({ status: "waiting", waitingFor: "account_selection" })
        expect(await storage.getAuthorization(authorizationKey(pending.id))).toEqual(pending)

        const selected = await storage.putConnectionFromRun({
          id: "connection-b",
          projectId,
          connectorId,
          runId: "run-a",
          account: { id: "account-b", label: "Account B" },
          replace: true,
        })
        expect(selected.run).toMatchObject({ status: "succeeded" })
      })
    })

    test("keeps one stable connection per project connector slot", async () => {
      await withStorage(async (storage) => {
        const first = await createAuthorization(storage, "authorization-a", "account-a")
        const firstConnection = await connect(storage, first, "connection-a", "account-a")
        const second = await createAuthorization(storage, "authorization-b", "account-b")

        await expect(connect(storage, second, "connection-b", "account-b")).rejects.toThrow(
          "explicit replacement is required"
        )
        const replaced = await storage.putConnection({
          id: "connection-b",
          projectId,
          connectorId,
          authorizationId: second.id,
          owner: { type: "project" },
          slot: "default",
          account: { id: "account-b", label: "ignored" },
          replace: true,
        })
        expect(replaced.connection.id).toBe(firstConnection.connection.id)
        expect(replaced.revocationPendingAuthorizationId).toBe(first.id)
        expect(await storage.getAuthorization(authorizationKey(first.id))).toMatchObject({
          status: "revocation_pending",
        })
        expect(
          await storage.getConnection({
            projectId,
            connectorId,
            owner: { type: "project" },
            slot: "default",
          })
        ).toMatchObject({ authorizationId: second.id, account: { id: "account-b" } })
      })
    })

    test("retains disconnected identities and reactivates the same slot id", async () => {
      await withStorage(async (storage) => {
        const first = await createAuthorization(storage, "authorization-a", "account-a")
        const connected = await connect(storage, first, "connection-a", "account-a")

        const disconnected = await storage.disconnectConnection({
          projectId,
          connectorId,
          connectionId: connected.connection.id,
        })
        expect(disconnected).toMatchObject({
          connection: { id: connected.connection.id, status: "disconnected" },
          authorization: { status: "revocation_pending" },
          revocationPendingAuthorizationId: first.id,
        })
        expect(
          await storage.getConnection({
            projectId,
            connectorId,
            owner: { type: "project" },
            slot: "default",
          })
        ).toBeNull()
        expect(
          await storage.getConnectionById({
            projectId,
            connectorId,
            connectionId: connected.connection.id,
          })
        ).toMatchObject({ status: "disconnected" })

        const second = await createAuthorization(storage, "authorization-b", "account-a")
        const reconnected = await connect(storage, second, "ignored-new-id", "account-a")
        expect(reconnected.connection).toMatchObject({
          id: connected.connection.id,
          authorizationId: second.id,
          status: "connected",
        })
      })
    })

    test("keeps pending selection untouched when connection validation fails", async () => {
      await withStorage(async (storage) => {
        const active = await createAuthorization(storage, "authorization-a", "account-a")
        const existing = await connect(storage, active, "connection-a", "account-a")
        const replacement = await createAuthorization(storage, "authorization-b", "account-b")

        await expect(connect(storage, replacement, "connection-b", "account-b")).rejects.toThrow(
          "explicit replacement is required"
        )
        expect(await storage.getAuthorization(authorizationKey(replacement.id))).toEqual(
          replacement
        )

        const duplicateId = await createAuthorization(storage, "authorization-c", "account-c")
        await expect(
          storage.putConnection({
            id: existing.connection.id,
            projectId,
            connectorId,
            authorizationId: duplicateId.id,
            owner: { type: "project" },
            slot: "secondary",
            account: { id: "account-c", label: "ignored" },
            replace: false,
          })
        ).rejects.toThrow("connection id already exists")
        expect(await storage.getAuthorization(authorizationKey(duplicateId.id))).toEqual(
          duplicateId
        )
      })
    })

    test("scopes direct record reads by project and connector", async () => {
      await withStorage(async (storage) => {
        const authorization = await createAuthorization(storage, "authorization-a", "account-a")
        const connected = await connect(storage, authorization, "connection-a", "account-a")

        expect(await storage.getAuthorization(authorizationKey(authorization.id))).toEqual(
          connected.authorization
        )
        for (const scope of [
          { projectId: "project-b", connectorId },
          { projectId, connectorId: "another-connector" },
        ]) {
          expect(
            await storage.getAuthorization({
              ...scope,
              authorizationId: authorization.id,
            })
          ).toBeNull()
          expect(
            await storage.getConnectionById({
              ...scope,
              connectionId: connected.connection.id,
            })
          ).toBeNull()
          expect(
            await storage.listConnectionsByAuthorization({
              ...scope,
              authorizationId: authorization.id,
            })
          ).toEqual([])
        }
      })
    })

    test("fences staged credentials by project, revision and mutation id", async () => {
      await withStorage(async (storage) => {
        const authorization = await createActiveAuthorization(storage)
        for (const scope of [
          { projectId: "project-b", connectorId },
          { projectId, connectorId: "another-connector" },
        ]) {
          await expect(
            storage.claimCredentialMutation({
              ...scope,
              authorizationId: authorization.id,
              expectedRevision: authorization.revision,
              mutation: { id: "mutation-a", kind: "refresh", holderId: "worker-a" },
              leaseDurationMs: 30_000,
              operationTimeoutMs: 60_000,
            })
          ).resolves.toBeNull()
        }

        const claim = await storage.claimCredentialMutation({
          projectId,
          connectorId,
          authorizationId: authorization.id,
          expectedRevision: authorization.revision,
          mutation: { id: "mutation-a", kind: "refresh", holderId: "worker-a" },
          leaseDurationMs: 30_000,
          operationTimeoutMs: 60_000,
        })
        expect(claim).not.toBeNull()
        const claimed = claim!.authorization
        const executing = await storage.markCredentialMutationExecuting({
          ...fence(claimed),
          holderId: "worker-a",
        })
        expect(executing?.credentialMutation?.phase).toBe("executing")
        for (const scope of [
          { projectId: "project-b", connectorId },
          { projectId, connectorId: "another-connector" },
        ]) {
          await expect(
            storage.stageCredentialMutationCredentials({
              ...fence(claimed),
              ...scope,
              holderId: "worker-a",
              credentials,
              scopes: [],
            })
          ).resolves.toBeNull()
        }
        await expect(
          storage.stageCredentialMutationCredentials({
            ...fence(claimed),
            mutationId: "stale-mutation",
            holderId: "worker-a",
            credentials,
            scopes: [],
          })
        ).resolves.toBeNull()

        const staged = await storage.stageCredentialMutationCredentials({
          ...fence(claimed),
          holderId: "worker-a",
          credentials,
          scopes: [],
        })
        expect(staged?.credentialMutation?.phase).toBe("result_staged")
        await expect(
          storage.finalizeRefresh({ ...fence(claimed), expectedRevision: claimed.revision + 1 })
        ).resolves.toBeNull()
        await expect(storage.finalizeRefresh(fence(claimed))).resolves.toMatchObject({
          revision: claimed.revision + 1,
          credentialMutation: undefined,
        })
      })
    })

    test("releases an expired prepared mutation without changing credential state", async () => {
      await withStorage(async (storage, root) => {
        const authorization = await createActiveAuthorization(storage)
        await claimMutation(storage, authorization, "mutation-prepared", "refresh", {
          leaseDurationMs: 10_000,
          operationTimeoutMs: 60_000,
        })

        await options.advanceTime(root, 10_000)
        await expect(
          storage.recoverExpiredCredentialMutation(authorizationKey(authorization.id))
        ).resolves.toMatchObject({
          status: "active",
          revision: authorization.revision,
          credentialMutation: undefined,
        })
      })
    })

    test("fails closed expired executing credential changes but keeps revocation retryable", async () => {
      for (const kind of ["refresh", "reauthorization"] as const) {
        await withStorage(async (storage, root) => {
          const authorization = await createActiveAuthorization(storage)
          const claim = await claimMutation(storage, authorization, `mutation-${kind}`, kind, {
            leaseDurationMs: 10_000,
            operationTimeoutMs: 60_000,
          })
          await markExecuting(storage, claim.authorization)

          await options.advanceTime(root, 10_000)
          await expect(
            storage.recoverExpiredCredentialMutation(authorizationKey(authorization.id))
          ).resolves.toMatchObject({
            status: "needs_reauthorization",
            revision: claim.authorization.revision + 1,
            credentialMutation: undefined,
          })
        })
      }

      await withStorage(async (storage, root) => {
        const authorization = await createActiveAuthorization(storage)
        const claim = await claimMutation(
          storage,
          authorization,
          "mutation-revocation",
          "revocation",
          { leaseDurationMs: 10_000, operationTimeoutMs: 60_000 }
        )
        await markExecuting(storage, claim.authorization)

        await options.advanceTime(root, 10_000)
        const recovered = await storage.recoverExpiredCredentialMutation(
          authorizationKey(authorization.id)
        )
        expect(recovered).toMatchObject({
          status: "revocation_pending",
          revision: claim.authorization.revision,
          credentialMutation: undefined,
        })
        if (!recovered) throw new Error("Expected expired revocation recovery.")
        await expect(
          claimMutation(storage, recovered, "mutation-revocation-retry", "revocation")
        ).resolves.toBeDefined()
      })
    })

    test("preserves a staged provider result after its lease and deadline", async () => {
      await withStorage(async (storage, root) => {
        const authorization = await createActiveAuthorization(storage)
        const claim = await claimMutation(storage, authorization, "mutation-staged", "refresh", {
          leaseDurationMs: 10_000,
          operationTimeoutMs: 20_000,
        })
        const executing = await markExecuting(storage, claim.authorization)
        const staged = await storage.stageCredentialMutationCredentials({
          ...fence(executing),
          holderId: "worker-a",
          credentials: { ...credentials, ciphertext: "refreshed" },
          scopes: ["accounts.read"],
        })
        expect(staged?.credentialMutation?.phase).toBe("result_staged")

        await options.advanceTime(root, 20_000)
        const recovered = await storage.recoverExpiredCredentialMutation(
          authorizationKey(authorization.id)
        )
        expect(recovered?.credentialMutation?.phase).toBe("result_staged")
        if (!recovered) throw new Error("Expected staged refresh recovery.")
        await expect(storage.finalizeRefresh(fence(recovered))).resolves.toMatchObject({
          status: "active",
          revision: authorization.revision + 1,
          scopes: ["accounts.read"],
          credentialMutation: undefined,
        })
      })
    })

    test("never renews a credential lease past its operation deadline", async () => {
      await withStorage(async (storage, root) => {
        const authorization = await createActiveAuthorization(storage)
        const claim = await claimMutation(storage, authorization, "mutation-renew", "refresh", {
          leaseDurationMs: 10_000,
          operationTimeoutMs: 25_000,
        })
        const executing = await markExecuting(storage, claim.authorization)
        const deadline = executing.credentialMutation!.deadlineAt

        await options.advanceTime(root, 8_000)
        const renewed = await storage.renewCredentialMutation({
          ...fence(executing),
          holderId: "worker-a",
          leaseDurationMs: 30_000,
        })
        expect(renewed?.credentialMutation?.expiresAt).toEqual(deadline)

        await options.advanceTime(root, 17_000)
        await expect(
          storage.recoverExpiredCredentialMutation(authorizationKey(authorization.id))
        ).resolves.toMatchObject({
          status: "needs_reauthorization",
          credentialMutation: undefined,
        })
      })
    })

    test("disconnects every local usage atomically when revocation starts", async () => {
      await withStorage(async (storage) => {
        const authorization = await createAuthorization(storage, "authorization-a", "account-a")
        const first = await connect(storage, authorization, "connection-a", "account-a")
        await storage.putConnection({
          id: "connection-b",
          projectId,
          connectorId,
          authorizationId: authorization.id,
          owner: { type: "project" },
          slot: "secondary",
          account: { id: "account-a", label: "ignored" },
          replace: false,
        })
        const active = (await storage.getAuthorization(authorizationKey(authorization.id)))!
        const claim = await storage.claimCredentialMutation({
          projectId,
          connectorId,
          authorizationId: authorization.id,
          expectedRevision: active.revision,
          mutation: { id: "mutation-revoke", kind: "revocation", holderId: "worker-a" },
          leaseDurationMs: 30_000,
          operationTimeoutMs: 60_000,
        })

        expect(claim?.authorization.status).toBe("revocation_pending")
        expect(claim?.disconnected.map((connection) => connection.id).sort()).toEqual(
          [first.connection.id, "connection-b"].sort()
        )
        expect(
          await storage.listConnectionsByAuthorization(authorizationKey(authorization.id))
        ).toEqual([])
        expect(
          await storage.getAuthorizationByConnectionId({
            projectId,
            connectorId,
            connectionId: first.connection.id,
          })
        ).toMatchObject({ id: authorization.id, status: "revocation_pending" })

        if (!claim) throw new Error("Expected revocation mutation claim.")
        const executing = await markExecuting(storage, claim.authorization)
        const staged = await storage.stageCredentialMutationRevocation({
          ...fence(executing),
          holderId: "worker-a",
        })
        if (!staged) throw new Error("Expected staged revocation.")
        const revoked = await storage.finalizeRevocation(fence(staged))
        expect(revoked).toMatchObject({
          status: "revoked",
          credentials: undefined,
          scopes: [],
          accounts: [],
        })
        expect(await storage.listConnections({ projectId, connectorId })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: first.connection.id, status: "disconnected" }),
            expect.objectContaining({ id: "connection-b", status: "disconnected" }),
          ])
        )
      })
    })

    test("freezes the attached connection set during reauthorization", async () => {
      await withStorage(async (storage) => {
        const authorization = await createActiveAuthorization(storage)
        const connections = await storage.listConnectionsByAuthorization(
          authorizationKey(authorization.id)
        )
        const claim = await storage.claimCredentialMutation({
          projectId,
          connectorId,
          authorizationId: authorization.id,
          expectedRevision: authorization.revision,
          mutation: {
            id: "mutation-reauthorize",
            kind: "reauthorization",
            holderId: "worker-a",
          },
          expectedConnectionIds: connections.map((connection) => connection.id),
          leaseDurationMs: 30_000,
          operationTimeoutMs: 60_000,
        })
        expect(claim).not.toBeNull()

        await expect(
          storage.disconnectConnection({
            projectId,
            connectorId,
            connectionId: connections[0].id,
          })
        ).rejects.toThrow("being reauthorized")
      })
    })
  })
}

function authorizationAttempt(
  overrides: Partial<CreateConnectorAuthorizationAttemptInput> = {}
): CreateConnectorAuthorizationAttemptInput {
  return {
    id: "attempt-a",
    projectId,
    connectorId,
    owner: { type: "project" },
    slot: "default",
    initiatedByExecutionId: "execution-a",
    stateHash: "state-hash",
    codeVerifier: credentials,
    redirectUri: "https://example.com/oauth/callback",
    ttlMs: 60_000,
    ...overrides,
  }
}

function connectionRun(
  overrides: Partial<CreateConnectorConnectionRunInput> = {}
): CreateConnectorConnectionRunInput {
  return {
    id: "run-a",
    projectId,
    connectorId,
    kind: "connect",
    owner: { type: "project" },
    slot: "default",
    initiatedByExecutionId: "execution-a",
    authorizationAttemptId: "attempt-a",
    ttlMs: 60_000,
    ...overrides,
  }
}

async function createSelectionRun(
  storage: ConnectorConnectionStorage,
  authorization: ConnectorAuthorizationRecord
): Promise<void> {
  await storage.createConnectionRun(connectionRun())
  await storage.createAuthorizationAttempt(
    authorizationAttempt({
      connectionRunId: "run-a",
      returnTo: "https://app.example.com/connectors",
      callbackBindingHash: "binding-hash",
    })
  )
  const claimed = await storage.claimConnectionRunCallback({
    projectId,
    attemptId: "attempt-a",
    stateHash: "state-hash",
    callbackBindingHash: "binding-hash",
    redirectUri: "https://example.com/oauth/callback",
  })
  if (!claimed || claimed.type !== "claimed") throw new Error("Expected callback claim.")
  const waiting = await storage.waitForConnectionRunSelection({
    projectId,
    connectorId,
    runId: "run-a",
    authorizationId: authorization.id,
    expiresAt: authorization.selectionExpiresAt!,
  })
  if (!waiting) throw new Error("Expected account-selection run.")
}

function authorizationKey(
  authorizationId: string,
  overrides: Partial<{ readonly projectId: string; readonly connectorId: string }> = {}
) {
  return { projectId, connectorId, authorizationId, ...overrides }
}

function authorizationAttemptConsumption(id = "attempt-a") {
  return {
    id,
    projectId,
    connectorId,
    stateHash: "state-hash",
    redirectUri: "https://example.com/oauth/callback",
  }
}

function requestExecution(id: string): CreateExecutionInput {
  const requestId = `request-${id}`
  return {
    id,
    projectId,
    executor: { type: "request", requestId },
    source: { type: "http", requestId },
    correlationId: `correlation-${id}`,
    authorizationRef: { type: "disabled" },
  }
}

function requireTransactionConnections(storage: Storage): ConnectorConnectionStorage {
  if (storage.connectorConnections) return storage.connectorConnections
  throw new Error("Connector connection storage is missing from the transaction facade.")
}

async function createAuthorization(
  storage: ConnectorConnectionStorage,
  id: string,
  accountId: string
): Promise<ConnectorAuthorizationRecord> {
  return storage.createAuthorization({
    id,
    projectId,
    connectorId,
    authorizedBy: { type: "user", id: "user-a" },
    credentials,
    scopes: [],
    accounts: [{ id: accountId, label: accountId }],
    selectionTtlMs: 60_000,
  })
}

async function createActiveAuthorization(
  storage: ConnectorConnectionStorage
): Promise<ConnectorAuthorizationRecord> {
  const authorization = await createAuthorization(storage, "authorization-a", "account-a")
  const result = await connect(storage, authorization, "connection-a", "account-a")
  return result.authorization
}

function connect(
  storage: ConnectorConnectionStorage,
  authorization: ConnectorAuthorizationRecord,
  connectionId: string,
  accountId: string
) {
  return storage.putConnection({
    id: connectionId,
    projectId,
    connectorId,
    authorizationId: authorization.id,
    owner: { type: "project" },
    slot: "default",
    account: { id: accountId, label: "ignored" },
    replace: false,
  })
}

async function claimMutation(
  storage: ConnectorConnectionStorage,
  authorization: ConnectorAuthorizationRecord,
  mutationId: string,
  kind: ConnectorCredentialMutationKind,
  timing: { readonly leaseDurationMs: number; readonly operationTimeoutMs: number } = {
    leaseDurationMs: 30_000,
    operationTimeoutMs: 60_000,
  }
): Promise<ClaimConnectorCredentialMutationResult> {
  const expectedConnectionIds =
    kind === "reauthorization"
      ? (await storage.listConnectionsByAuthorization(authorizationKey(authorization.id))).map(
          (connection) => connection.id
        )
      : undefined
  const claim = await storage.claimCredentialMutation({
    projectId,
    connectorId,
    authorizationId: authorization.id,
    expectedRevision: authorization.revision,
    mutation: { id: mutationId, kind, holderId: "worker-a" },
    ...(expectedConnectionIds === undefined ? {} : { expectedConnectionIds }),
    ...timing,
  })
  if (!claim) throw new Error(`Expected '${kind}' credential mutation claim.`)
  return claim
}

async function markExecuting(
  storage: ConnectorConnectionStorage,
  authorization: ConnectorAuthorizationRecord
): Promise<ConnectorAuthorizationRecord> {
  const executing = await storage.markCredentialMutationExecuting({
    ...fence(authorization),
    holderId: "worker-a",
  })
  if (!executing) throw new Error("Expected credential mutation execution.")
  return executing
}

function fence(authorization: ConnectorAuthorizationRecord) {
  return {
    projectId: authorization.projectId,
    connectorId: authorization.connectorId,
    authorizationId: authorization.id,
    expectedRevision: authorization.revision,
    mutationId: authorization.credentialMutation!.id,
  }
}
