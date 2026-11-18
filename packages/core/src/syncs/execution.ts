import { assertAuthorized, isRuntimeAllowed } from "../authorization"
import {
  type ConnectorDefinition,
  isOAuthConnectorDefinition,
  type OAuthConnectorAdapter,
} from "../connectors"
import type { ExecutionContext } from "../execution"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  SyncRunRecord,
} from "../storage/sync-runs"
import { createSyncAccountsRuntime, type SyncAccountsRuntime } from "./accounts"
import { mayRunConnection, type SyncConnections } from "./connections"
import { SyncValidationError } from "./errors"
import { type RequestSyncRunInput, requestSyncRun, type SyncRunRequestResults } from "./request"
import type { SyncDefinition } from "./types"

/**
 * The runs of the syncs you may run. On a sync of an OAuth connector, only the runs of the
 * connections you may run as well: the project's and your own, or everyone's with `can.manage` on
 * the connector.
 */
export interface SyncRunsRuntime {
  getById(runId: string): Promise<SyncRunRecord | null>
  list(
    input?: Omit<ListSyncRunsInput, "projectId" | "syncIds" | "visibleConnectionIds">
  ): Promise<ListSyncRunsResult>
  listLatest(syncIds: readonly string[]): Promise<ListLatestSyncRunsResult>
}

export interface SyncsRuntime {
  list(): readonly SyncDefinition[]
  getById(syncId: string): SyncDefinition | null
  /** Queue a run, or on a sync of an OAuth connector one run per connection the caller may run. */
  request(input: RequestSyncRunInput): Promise<SyncRunRequestResults>
  readonly runs: SyncRunsRuntime
  /** Where each connected account stands, on a sync of an OAuth connector. */
  readonly accounts: SyncAccountsRuntime
}

export function createSyncsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  source: Pick<SyncsRuntime, "list" | "getById">,
  connections?: SyncConnections
): SyncsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const allowed = (syncId: string) => isRuntimeAllowed(runtime, { kind: "sync.run", syncId })
  const visibleIds = () =>
    source
      .list()
      .filter((sync) => allowed(sync.id))
      .map((sync) => sync.id)
  const historyFilterIds = () =>
    authority.type === "unrestricted"
      ? undefined
      : authority.type === "principal"
        ? visibleIds()
        : []

  const getById = (syncId: string) => {
    if (authority.type === "denied" || authority.type === "delegated") return null
    const sync = source.getById(syncId)
    return sync && allowed(syncId) ? sync : null
  }

  /**
   * The connections whose runs of these syncs the caller sees, as `mayRunConnection` decides.
   * Undefined when nothing is left out: no sync reads an OAuth connector, or the caller sees all.
   */
  const visibleConnectionIds = async (syncs: readonly (SyncDefinition | null)[]) => {
    if (authority.type === "unrestricted" || execution.requestedBy === undefined) return undefined

    const connectors = new Map<string, ConnectorDefinition<string, OAuthConnectorAdapter>>()
    for (const sync of syncs) {
      if (sync && isOAuthConnectorDefinition(sync.connector)) {
        connectors.set(sync.connector.id, sync.connector)
      }
    }
    if (!connections || connectors.size === 0) return undefined

    const all = await Promise.all(
      [...connectors.values()].map((connector) => connections.listAll(connector))
    )
    return all
      .flat()
      .filter((connection) => mayRunConnection(runtime, execution, connection))
      .map(({ id }) => id)
  }

  return {
    list: () =>
      authority.type === "denied" || authority.type === "delegated"
        ? []
        : source.list().filter((sync) => allowed(sync.id)),
    getById,
    accounts: createSyncAccountsRuntime({
      runtime,
      execution,
      syncs: () => source.list(),
      runnable: getById,
      ...(connections === undefined ? {} : { connections }),
    }),
    request: async (input) => {
      assertAuthorized(runtime, { kind: "sync.run", syncId: input.syncId })
      const sync = source.getById(input.syncId)
      if (!sync) throw new SyncValidationError(`[Sixb] Unknown sync '${input.syncId}'`)
      const { syncId: _syncId, ...options } = input
      return requestSyncRun(runtime, execution, sync, options, connections)
    },
    runs: {
      getById: async (runId) => {
        if (authority.type === "denied" || authority.type === "delegated") return null
        const run =
          (await runtime.storage.syncRuns?.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        if (!run || !allowed(run.syncId)) return null

        const visible = await visibleConnectionIds([source.getById(run.syncId)])
        const hidden =
          run.connectionId !== undefined && visible?.includes(run.connectionId) === false
        return hidden ? null : run
      },
      list: async (input = {}) => {
        if (authority.type === "denied" || authority.type === "delegated") {
          return { runs: [], hasMore: false, total: 0 }
        }
        const storage = runtime.storage.syncRuns
        if (!storage) return { runs: [], hasMore: false, total: 0 }

        const syncs =
          input.syncId === undefined
            ? source.list().filter((sync) => allowed(sync.id))
            : [getById(input.syncId)]
        const visible = await visibleConnectionIds(syncs)
        return storage.list({
          ...input,
          syncIds: historyFilterIds(),
          ...(visible === undefined ? {} : { visibleConnectionIds: visible }),
          projectId: runtime.projectId,
        })
      },
      listLatest: async (syncIds) => {
        if (authority.type === "denied" || authority.type === "delegated") return { runs: [] }
        const storage = runtime.storage.syncRuns
        const allowedIds = syncIds.filter(allowed)
        if (!storage || allowedIds.length === 0) return { runs: [] }

        const visible = await visibleConnectionIds(
          allowedIds.map((syncId) => source.getById(syncId))
        )
        return storage.listLatestBySyncIds({
          projectId: runtime.projectId,
          syncIds: allowedIds,
          ...(visible === undefined ? {} : { visibleConnectionIds: visible }),
        })
      },
    },
  }
}
