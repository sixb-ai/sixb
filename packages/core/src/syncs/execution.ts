import { assertAuthorized, isRuntimeAllowed } from "../authorization"
import type { ExecutionContext } from "../execution"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  SyncRunRecord,
} from "../storage/sync-runs"
import type { SyncConnections } from "./connections"
import { SyncValidationError } from "./errors"
import { type RequestSyncRunInput, requestSyncRun, type SyncRunRequestResults } from "./request"
import type { SyncDefinition } from "./types"

export interface SyncRunsRuntime {
  getById(runId: string): Promise<SyncRunRecord | null>
  list(input?: Omit<ListSyncRunsInput, "projectId" | "syncIds">): Promise<ListSyncRunsResult>
  listLatest(syncIds: readonly string[]): Promise<ListLatestSyncRunsResult>
}

export interface SyncsRuntime {
  list(): readonly SyncDefinition[]
  getById(syncId: string): SyncDefinition | null
  /** Queue a run, or on a sync of an OAuth connector one run per connection the caller may run. */
  request(input: RequestSyncRunInput): Promise<SyncRunRequestResults>
  readonly runs: SyncRunsRuntime
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

  return {
    list: () =>
      authority.type === "denied" || authority.type === "delegated"
        ? []
        : source.list().filter((sync) => allowed(sync.id)),
    getById: (syncId) => {
      if (authority.type === "denied" || authority.type === "delegated") return null
      const sync = source.getById(syncId)
      return sync && allowed(syncId) ? sync : null
    },
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
        return run && allowed(run.syncId) ? run : null
      },
      list: (input = {}) => {
        if (authority.type === "denied" || authority.type === "delegated") {
          return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        }
        const storage = runtime.storage.syncRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          ...input,
          syncIds: historyFilterIds(),
          projectId: runtime.projectId,
        })
      },
      listLatest: (syncIds) => {
        if (authority.type === "denied" || authority.type === "delegated") {
          return Promise.resolve({ runs: [] })
        }
        const storage = runtime.storage.syncRuns
        if (!storage || syncIds.length === 0) return Promise.resolve({ runs: [] })
        const allowedIds = syncIds.filter(allowed)
        return allowedIds.length === 0
          ? Promise.resolve({ runs: [] })
          : storage.listLatestBySyncIds({ projectId: runtime.projectId, syncIds: allowedIds })
      },
    },
  }
}
