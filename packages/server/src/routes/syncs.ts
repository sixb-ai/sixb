import type { OntologySource, Sixb, SyncDefinition } from "@sixb/core"
import type { SyncRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  RequestSyncRunBodySchema,
  RequestSyncRunResponseSchema,
  SyncParamsSchema,
  SyncRunListResponseSchema,
  SyncRunsQuerySchema,
  SyncSchema,
} from "../schemas/syncs"
import {
  handleRouteError,
  parseDate,
  parseOptionalInt,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

function serializeSyncRun(run: SyncRunRecord) {
  return {
    id: run.id,
    projectId: run.projectId,
    syncId: run.syncId,
    datasetId: run.datasetId,
    mode: run.mode,
    status: run.status,
    startedAt: toIsoString(run.startedAt),
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    rowsRead: run.rowsRead,
    output: run.output,
    expectedLatestVersionId: run.expectedLatestVersionId,
    commitMessage: run.commitMessage,
    error: run.error,
  }
}

type SerializedSyncRun = ReturnType<typeof serializeSyncRun>

async function getLatestSyncRun(
  sixb: Sixb<readonly OntologySource[]>,
  syncId: string
): Promise<SerializedSyncRun | null> {
  if (!sixb.storage.syncRuns) {
    return null
  }

  const storage = sixb.storage.syncRuns
  const result = await storage.listLatestBySyncIds({
    projectId: sixb.id,
    syncIds: [syncId],
  })

  const [latest] = result.runs
  return latest ? serializeSyncRun(latest) : null
}

async function getLatestSyncRuns(
  sixb: Sixb<readonly OntologySource[]>,
  syncIds: readonly string[]
): Promise<Map<string, SerializedSyncRun>> {
  const storage = sixb.storage.syncRuns
  if (!storage || syncIds.length === 0) {
    return new Map()
  }

  const result = await storage.listLatestBySyncIds({
    projectId: sixb.id,
    syncIds,
  })

  return new Map(result.runs.map((run) => [run.syncId, serializeSyncRun(run)]))
}

function serializeSync(
  sync: SyncDefinition,
  latestRun: SerializedSyncRun | null
): ReturnType<typeof SyncSchema.parse> {
  return SyncSchema.parse({
    id: sync.id,
    mode: sync.config.mode,
    connector: {
      id: sync.connector.id,
      type: sync.connector.adapter.type,
    },
    target: {
      kind: "dataset",
      dataset: sync.target.dataset,
    },
    triggers: sync.triggers,
    latestRun,
  })
}

export function registerSyncRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/syncs",
      async (context) => {
        const { scoped } = requestAuthState(context)
        const syncs = scoped ? scoped.listSyncs() : sixb.listSyncs()
        const latestRuns = await getLatestSyncRuns(
          sixb,
          syncs.map((sync) => sync.id)
        )

        return syncs.map((sync) => serializeSync(sync, latestRuns.get(sync.id) ?? null))
      },
      {
        response: { 200: SyncSchema.array() },
        detail: {
          summary: "List registered syncs",
          tags: [OPENAPI_TAGS.syncs.name],
          operationId: "listSyncs",
        },
      }
    )
    .get(
      "/api/syncs/:syncId",
      async (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)
        const sync = scoped ? scoped.getSyncById(params.syncId) : sixb.getSyncById(params.syncId)
        if (!sync) {
          set.status = 404
          return { error: "Sync not found" }
        }

        return serializeSync(sync, await getLatestSyncRun(sixb, sync.id))
      },
      {
        params: SyncParamsSchema,
        response: { 200: SyncSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get sync metadata",
          tags: [OPENAPI_TAGS.syncs.name],
          operationId: "getSync",
        },
      }
    )
    .get(
      "/api/sync-runs",
      async (context) => {
        const { query, set } = context
        const { authz } = requestAuthState(context)
        try {
          const parsed = SyncRunsQuerySchema.parse(query)
          const storage = sixb.storage.syncRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Sync run storage")
          }

          // Scope to runnable syncs the same way workflow run history does: pass
          // the grant allowlist alongside any explicit syncId and let storage AND
          // them. An ungranted syncId yields an empty intersection (no rows), and
          // an empty allowlist short-circuits to no rows.
          const syncIds = authz ? [...authz.grants["run:sync"]] : undefined
          const result = await storage.list({
            projectId: sixb.id,
            syncId: parsed.syncId,
            syncIds,
            datasetId: parsed.datasetId,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

          return {
            runs: result.runs.map(serializeSyncRun),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: SyncRunsQuerySchema,
        response: {
          200: SyncRunListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List sync run history",
          tags: [OPENAPI_TAGS.syncRuns.name],
          operationId: "listSyncRuns",
        },
      }
    )
    .post(
      "/api/syncs/:syncId/runs",
      async (context) => {
        const { params, body, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const sync = sixb.getSyncById(params.syncId)
          if (!sync) {
            set.status = 404
            return { error: "Sync not found" }
          }

          const parsedBody = RequestSyncRunBodySchema.parse(body)
          const result = scoped
            ? await scoped.requestSyncRun({ syncId: sync.id, ...parsedBody })
            : await sixb.requestSyncRun({ syncId: sync.id, ...parsedBody })

          set.status = 202
          return {
            runId: result.runId,
            jobId: result.jobId ?? "",
            syncId: result.syncId,
            queuedAt: result.queuedAt,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: SyncParamsSchema,
        body: RequestSyncRunBodySchema,
        response: {
          202: RequestSyncRunResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request a sync run",
          tags: [OPENAPI_TAGS.syncRuns.name],
          operationId: "requestSyncRun",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
