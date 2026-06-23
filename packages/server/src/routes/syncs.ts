import { randomUUID } from "node:crypto"
import {
  assertAuthorized,
  type OntologySource,
  type Sixb,
  type SyncDefinition,
  type SyncRunRecord,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { ErrorResponseSchema } from "../schemas/common"
import {
  RequestSyncRunBodySchema,
  RequestSyncRunResponseSchema,
  SyncParamsSchema,
  SyncRunListResponseSchema,
  SyncRunsQuerySchema,
  SyncSchema,
} from "../schemas/syncs"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

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
        const syncs = scoped ? scoped.listSyncs() : sixb.getSyncDefinitions()
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
          tags: ["Syncs"],
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
          tags: ["Syncs"],
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
            return {
              runs: [],
              hasMore: false,
              total: 0,
            }
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
        response: { 200: SyncRunListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List sync run history",
          tags: ["Syncs"],
          operationId: "listSyncRuns",
        },
      }
    )
    .post(
      "/api/syncs/:syncId/runs",
      async (context) => {
        const { params, body, set } = context
        const { authz } = requestAuthState(context)
        try {
          const sync = sixb.getSyncById(params.syncId)
          if (!sync) {
            set.status = 404
            return { error: "Sync not found" }
          }

          if (!sixb.storage.syncRuns) {
            set.status = 400
            return { error: "Sync run storage is not configured" }
          }

          assertAuthorized(
            { authorization: authz ?? undefined },
            { kind: "sync.run", syncId: sync.id }
          )

          const parsedBody = RequestSyncRunBodySchema.parse(body)
          const runId = `run_${randomUUID()}`
          const queuedAt = new Date().toISOString()
          const [job] = await sixb.queues.syncRuns.enqueue({
            projectId: sixb.id,
            jobs: [
              {
                type: "sync.run.requested",
                payload: {
                  syncId: sync.id,
                  runId,
                  expectedLatestVersionId: parsedBody.expectedLatestVersionId,
                  commitMessage: parsedBody.commitMessage,
                },
              },
            ],
          })

          set.status = 202
          return {
            runId,
            jobId: job?.id ?? "",
            syncId: sync.id,
            queuedAt,
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
          tags: ["Syncs"],
          operationId: "requestSyncRun",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
