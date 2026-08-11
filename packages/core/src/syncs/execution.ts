import { isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ListLatestSyncRunsResult,
  ListSyncRunsInput,
  ListSyncRunsResult,
  SyncRunRecord,
} from "../storage/sync-runs"
import { SyncValidationError } from "./errors"
import { type RequestSyncRunInput, requestSyncRun, type SyncRunRequestResult } from "./request"
import type { SyncDefinition } from "./types"

export interface ExecutionSyncRunsRuntime {
  getById(runId: string): Promise<SyncRunRecord | null>
  list(input?: Omit<ListSyncRunsInput, "projectId" | "syncIds">): Promise<ListSyncRunsResult>
  listLatest(syncIds: readonly string[]): Promise<ListLatestSyncRunsResult>
}

export interface ExecutionSyncsRuntime {
  list(): readonly SyncDefinition[]
  getById(syncId: string): SyncDefinition | null
  request(input: RequestSyncRunInput): Promise<SyncRunRequestResult>
  readonly runs: ExecutionSyncRunsRuntime
}

export function createExecutionSyncsRuntime(
  runtime: SixbRuntimeContext,
  source: Pick<ExecutionSyncsRuntime, "list" | "getById">
): ExecutionSyncsRuntime {
  const allowed = (syncId: string) => isAllowed(runtime.authorization, { kind: "sync.run", syncId })
  const visibleIds = () =>
    source
      .list()
      .filter((sync) => allowed(sync.id))
      .map((sync) => sync.id)

  return {
    list: () => source.list().filter((sync) => allowed(sync.id)),
    getById: (syncId) => {
      const sync = source.getById(syncId)
      return sync && allowed(syncId) ? sync : null
    },
    request: async (input) => {
      const sync = source.getById(input.syncId)
      if (!sync) throw new SyncValidationError(`[Sixb] Unknown sync '${input.syncId}'`)
      return requestSyncRun(runtime, sync, input)
    },
    runs: {
      getById: async (runId) => {
        const run =
          (await runtime.storage.syncRuns?.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        return run && allowed(run.syncId) ? run : null
      },
      list: (input = {}) => {
        const storage = runtime.storage.syncRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          projectId: runtime.projectId,
          ...input,
          syncIds: runtime.authorization ? visibleIds() : undefined,
        })
      },
      listLatest: (syncIds) => {
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
