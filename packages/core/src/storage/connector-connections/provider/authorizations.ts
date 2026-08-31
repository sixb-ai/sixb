import { ConnectorConnectionStorageError } from "../errors"
import type {
  ClaimConnectorCredentialMutationInput,
  ClaimConnectorCredentialMutationResult,
  ConnectorAuthorizationKey,
  ConnectorAuthorizationRecord,
  ConnectorConnectionKey,
  ConnectorConnectionRecord,
  ConnectorCredentialMutationFence,
  CreateConnectorAuthorizationInput,
  FinalizeConnectorReauthorizationInput,
  InitializeConnectorAuthorizationAccountsInput,
  MarkConnectorAuthorizationNeedsReauthorizationInput,
  MarkConnectorCredentialMutationExecutingInput,
  RecoverExpiredConnectorCredentialMutationInput,
  ReleaseConnectorCredentialMutationInput,
  RenewConnectorCredentialMutationInput,
  StageConnectorCredentialMutationCredentialsInput,
  StageConnectorCredentialMutationRevocationInput,
} from "../types"
import {
  applyStagedCredentials,
  assertPositiveDuration,
  ConnectorConnectionOperations,
  canClaimMutation,
  disconnectConnectionRecord,
  leaseExpiry,
  matchesMutation,
  mutationExpired,
  sameIds,
  stagedCredentials,
} from "./shared"

export class DurableConnectorAuthorizations extends ConnectorConnectionOperations {
  createAuthorization(
    input: CreateConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord> {
    assertPositiveDuration(input.selectionTtlMs, "account selection TTL")
    return this.write(input, async (persistence) => {
      const now = await persistence.now()
      const record: ConnectorAuthorizationRecord = {
        id: input.id,
        projectId: input.projectId,
        connectorId: input.connectorId,
        authorizedBy: structuredClone(input.authorizedBy),
        credentials: structuredClone(input.credentials),
        ...(input.credentialExpiresAt === undefined
          ? {}
          : { credentialExpiresAt: new Date(input.credentialExpiresAt) }),
        scopes: [...input.scopes],
        accounts: structuredClone(input.accounts),
        status: "pending_selection",
        selectionExpiresAt: new Date(now.getTime() + input.selectionTtlMs),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      }
      if (!(await persistence.insertAuthorization(record))) {
        throw authorizationConflict("[Sixb] Connector authorization already exists.")
      }
      return structuredClone(record)
    })
  }

  initializeAuthorizationAccounts(
    input: InitializeConnectorAuthorizationAccountsInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !record ||
        record.revision !== input.expectedRevision ||
        record.status !== "pending_selection" ||
        record.credentialMutation
      ) {
        return null
      }
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        accounts: structuredClone(input.accounts),
        revision: record.revision + 1,
        updatedAt: await persistence.now(),
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  getAuthorization(input: ConnectorAuthorizationKey): Promise<ConnectorAuthorizationRecord | null> {
    return this.read(input, async (persistence) => {
      const authorization = await persistence.getAuthorization(input.authorizationId)
      return authorization ? structuredClone(authorization) : null
    })
  }

  getAuthorizationByConnectionId(
    input: ConnectorConnectionKey
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.read(input, async (persistence) => {
      const connection = await persistence.getConnectionById(input.connectionId)
      if (!connection) return null
      const authorization = await persistence.getAuthorization(connection.authorizationId)
      return authorization ? structuredClone(authorization) : null
    })
  }

  claimCredentialMutation(
    input: ClaimConnectorCredentialMutationInput
  ): Promise<ClaimConnectorCredentialMutationResult | null> {
    assertPositiveDuration(input.leaseDurationMs, "credential mutation lease duration")
    assertPositiveDuration(input.operationTimeoutMs, "credential mutation timeout")
    return this.write(input, async (persistence) => {
      const now = await persistence.now()
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !record ||
        record.revision !== input.expectedRevision ||
        !canClaimMutation(record.status, input.mutation.kind)
      ) {
        return null
      }

      if (record.credentialMutation) {
        const canReplacePrepared =
          record.credentialMutation.phase === "prepared" &&
          record.credentialMutation.expiresAt.getTime() <= now.getTime()
        if (!canReplacePrepared) return null
      }

      const attached = await persistence.listConnectionsByAuthorization(record.id, {
        connectedOnly: true,
      })
      if (
        input.mutation.kind === "reauthorization" &&
        !sameIds(
          attached.map((connection) => connection.id),
          input.expectedConnectionIds ?? []
        )
      ) {
        return null
      }

      const deadlineAt = new Date(now.getTime() + input.operationTimeoutMs)
      const mutation = {
        ...structuredClone(input.mutation),
        phase: "prepared" as const,
        expiresAt: leaseExpiry(now, input.leaseDurationMs, deadlineAt),
        deadlineAt,
        ...(input.mutation.kind === "reauthorization"
          ? { expectedConnectionIds: [...(input.expectedConnectionIds ?? [])] }
          : {}),
      }
      const startsRevocation =
        input.mutation.kind === "revocation" && record.status !== "revocation_pending"
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        status: input.mutation.kind === "revocation" ? "revocation_pending" : record.status,
        selectionExpiresAt:
          input.mutation.kind === "revocation" ? undefined : record.selectionExpiresAt,
        revision: startsRevocation ? record.revision + 1 : record.revision,
        credentialMutation: mutation,
        updatedAt: now,
      }
      await persistence.updateAuthorization(updated)

      const disconnected: ConnectorConnectionRecord[] = []
      if (input.mutation.kind === "revocation") {
        for (const connection of attached) {
          const updatedConnection = disconnectConnectionRecord(connection, now)
          await persistence.updateConnection(updatedConnection)
          disconnected.push(structuredClone(updatedConnection))
        }
      }
      return { authorization: structuredClone(updated), disconnected }
    })
  }

  markCredentialMutationExecuting(
    input: MarkConnectorCredentialMutationExecutingInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const now = await persistence.now()
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !matchesMutation(record, input, input.holderId) ||
        record.credentialMutation.phase !== "prepared" ||
        mutationExpired(record, now)
      ) {
        return null
      }
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        credentialMutation: { ...record.credentialMutation, phase: "executing" },
        updatedAt: now,
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  renewCredentialMutation(
    input: RenewConnectorCredentialMutationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    assertPositiveDuration(input.leaseDurationMs, "credential mutation lease duration")
    return this.write(input, async (persistence) => {
      const now = await persistence.now()
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !matchesMutation(record, input, input.holderId) ||
        record.credentialMutation.phase === "result_staged" ||
        mutationExpired(record, now)
      ) {
        return null
      }
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        credentialMutation: {
          ...record.credentialMutation,
          expiresAt: leaseExpiry(now, input.leaseDurationMs, record.credentialMutation.deadlineAt),
        },
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  stageCredentialMutationCredentials(
    input: StageConnectorCredentialMutationCredentialsInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const now = await persistence.now()
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !matchesMutation(record, input, input.holderId) ||
        record.credentialMutation.phase !== "executing" ||
        mutationExpired(record, now) ||
        record.credentialMutation.kind === "revocation"
      ) {
        return null
      }
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        credentialMutation: {
          ...record.credentialMutation,
          phase: "result_staged",
          stagedCredentials: {
            credentials: structuredClone(input.credentials),
            ...(input.credentialExpiresAt === undefined
              ? {}
              : { credentialExpiresAt: new Date(input.credentialExpiresAt) }),
            scopes: [...input.scopes],
          },
        },
        updatedAt: now,
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  stageCredentialMutationRevocation(
    input: StageConnectorCredentialMutationRevocationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const now = await persistence.now()
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !matchesMutation(record, input, input.holderId) ||
        record.credentialMutation.phase !== "executing" ||
        record.credentialMutation.kind !== "revocation" ||
        mutationExpired(record, now)
      ) {
        return null
      }
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        credentialMutation: { ...record.credentialMutation, phase: "result_staged" },
        updatedAt: now,
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  releaseCredentialMutation(input: ReleaseConnectorCredentialMutationInput): Promise<boolean> {
    return this.write(input, async (persistence) => {
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !matchesMutation(record, input, input.holderId) ||
        record.credentialMutation.phase === "result_staged"
      ) {
        return false
      }
      await persistence.updateAuthorization({
        ...record,
        credentialMutation: undefined,
        updatedAt: await persistence.now(),
      })
      return true
    })
  }

  recoverExpiredCredentialMutation(
    input: RecoverExpiredConnectorCredentialMutationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const record = await persistence.getAuthorization(input.authorizationId)
      if (!record?.credentialMutation) return null
      if (record.credentialMutation.phase === "result_staged") return structuredClone(record)

      const now = await persistence.now()
      if (!mutationExpired(record, now)) return null
      const ambiguous = record.credentialMutation.phase === "executing"
      const failClosed = ambiguous && record.credentialMutation.kind !== "revocation"
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        status: failClosed ? "needs_reauthorization" : record.status,
        selectionExpiresAt: failClosed ? undefined : record.selectionExpiresAt,
        revision: failClosed ? record.revision + 1 : record.revision,
        credentialMutation: undefined,
        updatedAt: now,
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  markNeedsReauthorization(
    input: MarkConnectorAuthorizationNeedsReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const record = await persistence.getAuthorization(input.authorizationId)
      if (!matchesMutation(record, input)) return null
      const staged = record.credentialMutation.stagedCredentials
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        ...(staged
          ? {
              credentials: structuredClone(staged.credentials),
              credentialExpiresAt:
                staged.credentialExpiresAt === undefined
                  ? undefined
                  : new Date(staged.credentialExpiresAt),
              scopes: [...staged.scopes],
            }
          : {}),
        status: "needs_reauthorization",
        selectionExpiresAt: undefined,
        revision: record.revision + 1,
        credentialMutation: undefined,
        updatedAt: await persistence.now(),
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  finalizeRefresh(
    input: ConnectorCredentialMutationFence
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const record = await persistence.getAuthorization(input.authorizationId)
      const staged = stagedCredentials(record, input, "refresh")
      if (!record || !staged) return null
      const updated = applyStagedCredentials(record, staged, await persistence.now(), {
        accounts: record.accounts,
      })
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }

  finalizeReauthorization(
    input: FinalizeConnectorReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const record = await persistence.getAuthorization(input.authorizationId)
      const staged = stagedCredentials(record, input, "reauthorization")
      if (!record || !staged || !record.credentialMutation) return null
      const attached = await persistence.listConnectionsByAuthorization(record.id, {
        connectedOnly: true,
      })
      if (
        !sameIds(
          attached.map((connection) => connection.id),
          record.credentialMutation.expectedConnectionIds ?? []
        )
      ) {
        throw authorizationConflict(
          "[Sixb] Connections attached to the connector authorization changed during reauthorization."
        )
      }
      const accountsById = new Map(input.accounts.map((account) => [account.id, account]))
      if (attached.some((connection) => !accountsById.has(connection.account.id))) {
        throw authorizationConflict(
          "[Sixb] Reauthorized connector grant no longer exposes every attached account."
        )
      }

      const now = await persistence.now()
      const updated = applyStagedCredentials(record, staged, now, { accounts: input.accounts })
      await persistence.updateAuthorization(updated)
      for (const connection of attached) {
        await persistence.updateConnection({
          ...connection,
          account: structuredClone(accountsById.get(connection.account.id)!),
          updatedAt: now,
        })
      }
      return structuredClone(updated)
    })
  }

  finalizeRevocation(
    input: ConnectorCredentialMutationFence
  ): Promise<ConnectorAuthorizationRecord | null> {
    return this.write(input, async (persistence) => {
      const record = await persistence.getAuthorization(input.authorizationId)
      if (
        !matchesMutation(record, input) ||
        record.credentialMutation.kind !== "revocation" ||
        record.credentialMutation.phase !== "result_staged"
      ) {
        return null
      }
      const updated: ConnectorAuthorizationRecord = {
        ...record,
        status: "revoked",
        credentials: undefined,
        credentialExpiresAt: undefined,
        scopes: [],
        accounts: [],
        selectionExpiresAt: undefined,
        revision: record.revision + 1,
        credentialMutation: undefined,
        updatedAt: await persistence.now(),
      }
      await persistence.updateAuthorization(updated)
      return structuredClone(updated)
    })
  }
}

function authorizationConflict(message: string) {
  return new ConnectorConnectionStorageError("authorization_conflict", message)
}
