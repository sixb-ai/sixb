import { ConnectorConnectionStorageError } from "../errors"
import type {
  ConnectorConnectionKey,
  ConnectorConnectionRecord,
  ConnectorConnectionRunSucceededRecord,
  DisconnectConnectorConnectionResult,
  GetConnectorConnectionInput,
  ListConnectorConnectionsInput,
  PutConnectorConnectionFromRunInput,
  PutConnectorConnectionFromRunResult,
  PutConnectorConnectionInput,
  PutConnectorConnectionResult,
} from "../types"
import {
  assertConnectionCanMove,
  authorizationConflict,
  ConnectorConnectionOperations,
  type ConnectorConnectionPersistence,
  connectionRunBase,
  currentConnectionRun,
  disconnectConnectionRecord,
  invalidRun,
  isSelectable,
  markAuthorizationRevocationPending,
} from "./shared"

export class DurableConnectorConnections extends ConnectorConnectionOperations {
  async putConnection(input: PutConnectorConnectionInput): Promise<PutConnectorConnectionResult> {
    const outcome = await this.write(input, async (persistence) =>
      this.putConnectionNow(persistence, input, await persistence.now())
    )
    if ("error" in outcome) throw outcome.error
    return outcome
  }

  async putConnectionFromRun(
    input: PutConnectorConnectionFromRunInput
  ): Promise<PutConnectorConnectionFromRunResult> {
    const outcome = await this.write(input, async (persistence) => {
      const run = await currentConnectionRun(persistence, input.runId)
      if (!run || run.status !== "waiting" || run.waitingFor !== "account_selection") {
        return { error: invalidRun() }
      }
      const now = await persistence.now()
      const result = await this.putConnectionNow(
        persistence,
        {
          id: input.id,
          projectId: input.projectId,
          connectorId: input.connectorId,
          owner: run.owner,
          slot: run.slot,
          authorizationId: run.authorizationId,
          account: input.account,
          replace: input.replace,
        },
        now
      )
      if ("error" in result) return result
      const succeeded: ConnectorConnectionRunSucceededRecord = {
        ...connectionRunBase(run, now),
        status: "succeeded",
        authorizationId: run.authorizationId,
        ...(result.revocationPendingAuthorizationId === undefined
          ? {}
          : { cleanupAuthorizationId: result.revocationPendingAuthorizationId }),
        connections: [structuredClone(result.connection)],
        finishedAt: now,
      }
      await persistence.updateConnectionRun(succeeded)
      return { ...result, run: structuredClone(succeeded) }
    })
    if ("error" in outcome) throw outcome.error
    return outcome
  }

  getConnection(input: GetConnectorConnectionInput): Promise<ConnectorConnectionRecord | null> {
    return this.read(input, async (persistence) => {
      const connection = await persistence.getConnectionBySelector(input)
      return connection?.status === "connected" ? structuredClone(connection) : null
    })
  }

  getConnectionById(input: ConnectorConnectionKey): Promise<ConnectorConnectionRecord | null> {
    return this.read(input, async (persistence) => {
      const connection = await persistence.getConnectionById(input.connectionId)
      return connection ? structuredClone(connection) : null
    })
  }

  listConnections(
    input: ListConnectorConnectionsInput
  ): Promise<readonly ConnectorConnectionRecord[]> {
    return this.read(input, async (persistence) =>
      structuredClone(await persistence.listConnections())
    )
  }

  listConnectionsByAuthorization(input: {
    readonly projectId: string
    readonly connectorId: string
    readonly authorizationId: string
  }): Promise<readonly ConnectorConnectionRecord[]> {
    return this.read(input, async (persistence) => {
      if (!(await persistence.getAuthorization(input.authorizationId))) return []
      return structuredClone(
        await persistence.listConnectionsByAuthorization(input.authorizationId, {
          connectedOnly: true,
        })
      )
    })
  }

  disconnectConnection(
    input: ConnectorConnectionKey
  ): Promise<DisconnectConnectorConnectionResult | null> {
    return this.write(input, async (persistence) => {
      const connection = await persistence.getConnectionById(input.connectionId)
      if (!connection) return null
      const authorization = await persistence.getAuthorization(connection.authorizationId)
      if (!authorization) {
        throw new ConnectorConnectionStorageError(
          "authorization_conflict",
          "[Sixb] Connector connection references an unavailable authorization."
        )
      }
      if (connection.status === "disconnected") {
        return {
          connection: structuredClone(connection),
          authorization: structuredClone(authorization),
          ...(authorization.status === "revocation_pending"
            ? { revocationPendingAuthorizationId: authorization.id }
            : {}),
        }
      }

      const now = await persistence.now()
      const remaining = (
        await persistence.listConnectionsByAuthorization(authorization.id, {
          connectedOnly: true,
        })
      ).filter((candidate) => candidate.id !== connection.id)
      assertConnectionCanMove(authorization, remaining.length === 0)
      const disconnected = disconnectConnectionRecord(connection, now)
      await persistence.updateConnection(disconnected)
      const updatedAuthorization =
        remaining.length === 0
          ? markAuthorizationRevocationPending(authorization, now)
          : authorization
      if (updatedAuthorization !== authorization) {
        await persistence.updateAuthorization(updatedAuthorization)
      }
      return {
        connection: structuredClone(disconnected),
        authorization: structuredClone(updatedAuthorization),
        ...(updatedAuthorization.status === "revocation_pending" && remaining.length === 0
          ? { revocationPendingAuthorizationId: updatedAuthorization.id }
          : {}),
      }
    })
  }

  private async putConnectionNow(
    persistence: ConnectorConnectionPersistence,
    input: PutConnectorConnectionInput,
    now: Date
  ): Promise<PutConnectorConnectionResult | CommittedConnectorConnectionError> {
    let authorization = await persistence.getAuthorization(input.authorizationId)
    if (
      !authorization ||
      !isSelectable(authorization.status) ||
      authorization.credentialMutation?.kind === "reauthorization"
    ) {
      throw authorizationConflict()
    }
    if (
      authorization.status === "pending_selection" &&
      authorization.selectionExpiresAt!.getTime() <= now.getTime()
    ) {
      authorization = {
        ...authorization,
        status: "revocation_pending",
        selectionExpiresAt: undefined,
        revision: authorization.revision + 1,
        updatedAt: now,
      }
      await persistence.updateAuthorization(authorization)
      return { error: authorizationConflict() }
    }
    const account = authorization.accounts.find((candidate) => candidate.id === input.account.id)
    if (!account) {
      throw new ConnectorConnectionStorageError(
        "authorization_conflict",
        "[Sixb] Connector connection account is not exposed by its authorization."
      )
    }
    const existing = await persistence.getConnectionBySelector(input)
    const sameAccount = existing?.account.id === account.id
    if (existing && !sameAccount && !input.replace) {
      throw new ConnectorConnectionStorageError(
        "connection_conflict",
        `[Sixb] Connector slot '${input.slot}' is already connected to another account; explicit replacement is required.`
      )
    }
    if (!existing && (await persistence.getConnectionById(input.id))) {
      throw new ConnectorConnectionStorageError(
        "connection_conflict",
        "[Sixb] Connector connection id already exists."
      )
    }

    let revocationPendingAuthorizationId: string | undefined
    if (existing?.status === "connected" && existing.authorizationId !== authorization.id) {
      const previous = await persistence.getAuthorization(existing.authorizationId)
      if (!previous) {
        throw new ConnectorConnectionStorageError(
          "authorization_conflict",
          "[Sixb] Existing connector connection references an unavailable authorization."
        )
      }
      const remaining = (
        await persistence.listConnectionsByAuthorization(previous.id, { connectedOnly: true })
      ).filter((connection) => connection.id !== existing.id)
      assertConnectionCanMove(previous, remaining.length === 0)
      if (remaining.length === 0) {
        await persistence.updateAuthorization(markAuthorizationRevocationPending(previous, now))
        revocationPendingAuthorizationId = previous.id
      }
    } else if (existing?.status === "connected") {
      const previous = await persistence.getAuthorization(existing.authorizationId)
      if (previous) assertConnectionCanMove(previous, false)
    }

    const updatedAuthorization =
      authorization.status === "pending_selection"
        ? {
            ...authorization,
            status: "active" as const,
            selectionExpiresAt: undefined,
            revision: authorization.revision + 1,
            updatedAt: now,
          }
        : authorization
    const connection: ConnectorConnectionRecord = existing
      ? {
          ...existing,
          authorizationId: input.authorizationId,
          account: structuredClone(account),
          status: "connected",
          disconnectedAt: undefined,
          updatedAt: now,
        }
      : {
          id: input.id,
          projectId: input.projectId,
          connectorId: input.connectorId,
          owner: structuredClone(input.owner),
          slot: input.slot,
          authorizationId: input.authorizationId,
          account: structuredClone(account),
          status: "connected",
          createdAt: now,
          updatedAt: now,
        }

    if (updatedAuthorization !== authorization) {
      await persistence.updateAuthorization(updatedAuthorization)
    }
    if (existing) {
      await persistence.updateConnection(connection)
    } else if (!(await persistence.insertConnection(connection))) {
      throw new ConnectorConnectionStorageError(
        "connection_conflict",
        "[Sixb] Connector connection id already exists."
      )
    }
    return {
      connection: structuredClone(connection),
      authorization: structuredClone(updatedAuthorization),
      ...(revocationPendingAuthorizationId === undefined
        ? {}
        : { revocationPendingAuthorizationId }),
      created: existing === null,
      replaced: existing !== null && !sameAccount,
    }
  }
}

interface CommittedConnectorConnectionError {
  readonly error: ConnectorConnectionStorageError
}
