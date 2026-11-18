import { type ConnectorConnectionMetadata, isOAuthConnectorDefinition } from "../connectors"
import type { ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"
import type { SyncRunRecord } from "../storage/sync-runs"
import { mayRunConnection, type SyncConnections, seesConnection } from "./connections"
import type { SyncDefinition } from "./types"

/** One connected account of an OAuth connector, and how each of its syncs last ran. */
export interface SyncAccount {
  readonly connection: ConnectorConnectionMetadata
  /** The latest run of each of the connector's syncs you may run. Empty before the first. */
  readonly latestRuns: readonly SyncRunRecord[]
}

/** Where each connected account stands, for the syncs that run once per account. */
export interface SyncAccountsRuntime {
  /**
   * The connected accounts of an OAuth connector, with the latest run of each sync you may run:
   * the project's and your own, or everyone's with `can.manage` on the connector. Empty for a
   * static connector, or when you may run none of its syncs.
   */
  list(connectorId: string): Promise<readonly SyncAccount[]>
  /**
   * The latest run of each sync of one connection you see: your own, or anyone's with
   * `can.manage` on its connector. Empty for a connection you don't see.
   */
  latestRuns(connectorId: string, connectionId: string): Promise<readonly SyncRunRecord[]>
}

export function createSyncAccountsRuntime(input: {
  readonly runtime: SixbRuntimeContext
  readonly execution: ExecutionContext
  /** Every sync definition, whether or not the caller may run it. */
  readonly syncs: () => readonly SyncDefinition[]
  /** The syncs the caller may run. */
  readonly runnable: (syncId: string) => SyncDefinition | null
  readonly connections?: SyncConnections
}): SyncAccountsRuntime {
  const { runtime, execution, connections } = input
  const latestByConnection = (syncIds: readonly string[], connectionIds?: readonly string[]) =>
    runtime.storage.syncRuns
      ? runtime.storage.syncRuns
          .listLatestByConnection({
            projectId: runtime.projectId,
            syncIds,
            ...(connectionIds === undefined ? {} : { connectionIds }),
          })
          .then(({ runs }) => runs)
      : Promise.resolve([])

  return {
    async list(connectorId) {
      const syncs = input
        .syncs()
        .filter((sync) => sync.connector.id === connectorId && input.runnable(sync.id))
      const connector = syncs[0]?.connector
      if (!connections || !connector || !isOAuthConnectorDefinition(connector)) return []

      const accounts = (await connections.list(connector)).filter((connection) =>
        mayRunConnection(runtime, execution, connection)
      )
      const runs = await latestByConnection(
        syncs.map(({ id }) => id),
        accounts.map(({ id }) => id)
      )
      return accounts.map((connection) => ({
        connection,
        latestRuns: runs.filter((run) => run.connectionId === connection.id),
      }))
    },

    async latestRuns(connectorId, connectionId) {
      const syncs = input.syncs().filter((sync) => sync.connector.id === connectorId)
      const connector = syncs[0]?.connector
      if (!connections || !connector || !isOAuthConnectorDefinition(connector)) return []

      const connection = (await connections.list(connector)).find(({ id }) => id === connectionId)
      if (!connection || !seesConnection(runtime, execution, connection)) return []
      return latestByConnection(
        syncs.map(({ id }) => id),
        [connection.id]
      )
    },
  }
}
