import { DurableConnectorAuthorizations } from "./provider/authorizations"
import { DurableConnectorConnections } from "./provider/connections"
import { DurableConnectorConnectionRuns } from "./provider/runs"
import type { ConnectorConnectionPersistenceBackend } from "./provider/shared"
import type { ConnectorConnectionStorage } from "./types"

export type {
  ConnectorConnectionPersistence,
  ConnectorConnectionPersistenceBackend,
  ConnectorConnectionPersistenceScope,
} from "./provider/shared"

/**
 * Shared durable implementation of the Connector connection lifecycle.
 *
 * Concrete providers own SQL, transactions, database time and per-connector serialization. The
 * focused services below own protocol runs, authorization mutations and stable connections so
 * SQLite and PostgreSQL cannot drift semantically.
 */
export class DurableConnectorConnectionStorage implements ConnectorConnectionStorage {
  readonly durability = "durable" as const
  private readonly runs: DurableConnectorConnectionRuns
  private readonly authorizations: DurableConnectorAuthorizations
  private readonly connections: DurableConnectorConnections

  constructor(backend: ConnectorConnectionPersistenceBackend) {
    this.runs = new DurableConnectorConnectionRuns(backend)
    this.authorizations = new DurableConnectorAuthorizations(backend)
    this.connections = new DurableConnectorConnections(backend)
  }

  async createAuthorizationAttempt(
    ...args: Parameters<ConnectorConnectionStorage["createAuthorizationAttempt"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["createAuthorizationAttempt"]>>> {
    return this.runs.createAuthorizationAttempt(...args)
  }

  async consumeAuthorizationAttempt(
    ...args: Parameters<ConnectorConnectionStorage["consumeAuthorizationAttempt"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["consumeAuthorizationAttempt"]>>> {
    return this.runs.consumeAuthorizationAttempt(...args)
  }

  async createConnectionRun(
    ...args: Parameters<ConnectorConnectionStorage["createConnectionRun"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["createConnectionRun"]>>> {
    return this.runs.createConnectionRun(...args)
  }

  async createConnectionSelectionRun(
    ...args: Parameters<ConnectorConnectionStorage["createConnectionSelectionRun"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["createConnectionSelectionRun"]>>> {
    return this.runs.createConnectionSelectionRun(...args)
  }

  async claimConnectionRunCallback(
    ...args: Parameters<ConnectorConnectionStorage["claimConnectionRunCallback"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["claimConnectionRunCallback"]>>> {
    return this.runs.claimConnectionRunCallback(...args)
  }

  async attachConnectionRunAuthorization(
    ...args: Parameters<ConnectorConnectionStorage["attachConnectionRunAuthorization"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["attachConnectionRunAuthorization"]>>> {
    return this.runs.attachConnectionRunAuthorization(...args)
  }

  async waitForConnectionRunSelection(
    ...args: Parameters<ConnectorConnectionStorage["waitForConnectionRunSelection"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["waitForConnectionRunSelection"]>>> {
    return this.runs.waitForConnectionRunSelection(...args)
  }

  async finishConnectionRun(
    ...args: Parameters<ConnectorConnectionStorage["finishConnectionRun"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["finishConnectionRun"]>>> {
    return this.runs.finishConnectionRun(...args)
  }

  async getConnectionRun(
    ...args: Parameters<ConnectorConnectionStorage["getConnectionRun"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["getConnectionRun"]>>> {
    return this.runs.getConnectionRun(...args)
  }

  async createAuthorization(
    ...args: Parameters<ConnectorConnectionStorage["createAuthorization"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["createAuthorization"]>>> {
    return this.authorizations.createAuthorization(...args)
  }

  async initializeAuthorizationAccounts(
    ...args: Parameters<ConnectorConnectionStorage["initializeAuthorizationAccounts"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["initializeAuthorizationAccounts"]>>> {
    return this.authorizations.initializeAuthorizationAccounts(...args)
  }

  async getAuthorization(
    ...args: Parameters<ConnectorConnectionStorage["getAuthorization"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["getAuthorization"]>>> {
    return this.authorizations.getAuthorization(...args)
  }

  async getAuthorizationByConnectionId(
    ...args: Parameters<ConnectorConnectionStorage["getAuthorizationByConnectionId"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["getAuthorizationByConnectionId"]>>> {
    return this.authorizations.getAuthorizationByConnectionId(...args)
  }

  async claimCredentialMutation(
    ...args: Parameters<ConnectorConnectionStorage["claimCredentialMutation"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["claimCredentialMutation"]>>> {
    return this.authorizations.claimCredentialMutation(...args)
  }

  async markCredentialMutationExecuting(
    ...args: Parameters<ConnectorConnectionStorage["markCredentialMutationExecuting"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["markCredentialMutationExecuting"]>>> {
    return this.authorizations.markCredentialMutationExecuting(...args)
  }

  async renewCredentialMutation(
    ...args: Parameters<ConnectorConnectionStorage["renewCredentialMutation"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["renewCredentialMutation"]>>> {
    return this.authorizations.renewCredentialMutation(...args)
  }

  async stageCredentialMutationCredentials(
    ...args: Parameters<ConnectorConnectionStorage["stageCredentialMutationCredentials"]>
  ): Promise<
    Awaited<ReturnType<ConnectorConnectionStorage["stageCredentialMutationCredentials"]>>
  > {
    return this.authorizations.stageCredentialMutationCredentials(...args)
  }

  async stageCredentialMutationRevocation(
    ...args: Parameters<ConnectorConnectionStorage["stageCredentialMutationRevocation"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["stageCredentialMutationRevocation"]>>> {
    return this.authorizations.stageCredentialMutationRevocation(...args)
  }

  async releaseCredentialMutation(
    ...args: Parameters<ConnectorConnectionStorage["releaseCredentialMutation"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["releaseCredentialMutation"]>>> {
    return this.authorizations.releaseCredentialMutation(...args)
  }

  async recoverExpiredCredentialMutation(
    ...args: Parameters<ConnectorConnectionStorage["recoverExpiredCredentialMutation"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["recoverExpiredCredentialMutation"]>>> {
    return this.authorizations.recoverExpiredCredentialMutation(...args)
  }

  async markNeedsReauthorization(
    ...args: Parameters<ConnectorConnectionStorage["markNeedsReauthorization"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["markNeedsReauthorization"]>>> {
    return this.authorizations.markNeedsReauthorization(...args)
  }

  async finalizeRefresh(
    ...args: Parameters<ConnectorConnectionStorage["finalizeRefresh"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["finalizeRefresh"]>>> {
    return this.authorizations.finalizeRefresh(...args)
  }

  async finalizeReauthorization(
    ...args: Parameters<ConnectorConnectionStorage["finalizeReauthorization"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["finalizeReauthorization"]>>> {
    return this.authorizations.finalizeReauthorization(...args)
  }

  async finalizeRevocation(
    ...args: Parameters<ConnectorConnectionStorage["finalizeRevocation"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["finalizeRevocation"]>>> {
    return this.authorizations.finalizeRevocation(...args)
  }

  async putConnection(
    ...args: Parameters<ConnectorConnectionStorage["putConnection"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["putConnection"]>>> {
    return this.connections.putConnection(...args)
  }

  async putConnectionFromRun(
    ...args: Parameters<ConnectorConnectionStorage["putConnectionFromRun"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["putConnectionFromRun"]>>> {
    return this.connections.putConnectionFromRun(...args)
  }

  async getConnection(
    ...args: Parameters<ConnectorConnectionStorage["getConnection"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["getConnection"]>>> {
    return this.connections.getConnection(...args)
  }

  async getConnectionById(
    ...args: Parameters<ConnectorConnectionStorage["getConnectionById"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["getConnectionById"]>>> {
    return this.connections.getConnectionById(...args)
  }

  async listConnections(
    ...args: Parameters<ConnectorConnectionStorage["listConnections"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["listConnections"]>>> {
    return this.connections.listConnections(...args)
  }

  async listConnectionsByAuthorization(
    ...args: Parameters<ConnectorConnectionStorage["listConnectionsByAuthorization"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["listConnectionsByAuthorization"]>>> {
    return this.connections.listConnectionsByAuthorization(...args)
  }

  async disconnectConnection(
    ...args: Parameters<ConnectorConnectionStorage["disconnectConnection"]>
  ): Promise<Awaited<ReturnType<ConnectorConnectionStorage["disconnectConnection"]>>> {
    return this.connections.disconnectConnection(...args)
  }
}
