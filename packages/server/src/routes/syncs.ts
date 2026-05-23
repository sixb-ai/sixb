import { randomUUID } from "node:crypto"
import type { OntologySource, Sixb, SyncDefinition, SyncRunRecord } from "@sixb/core"
import type { Elysia } from "elysia"
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

async function getLatestSyncRun(
  sixb: Sixb<readonly OntologySource[]>,
  syncId: string
): Promise<ReturnType<typeof serializeSyncRun> | null> {
  if (!sixb.storage.syncRuns) {
    return null
  }

  const result = await sixb.storage.syncRuns.list({
    projectId: sixb.id,
    syncId,
    limit: 1,
    order: "desc",
  })

  const [latest] = result.runs
  return latest ? serializeSyncRun(latest) : null
}

async function serializeSync(
  sixb: Sixb<readonly OntologySource[]>,
  sync: SyncDefinition
): Promise<ReturnType<typeof SyncSchema.parse>> {
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
    latestRun: await getLatestSyncRun(sixb, sync.id),
  })
}

export function registerSyncRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/syncs",
      async () => {
        return await Promise.all(sixb.getSyncDefinitions().map((sync) => serializeSync(sixb, sync)))
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
      async ({ params, set }) => {
        const sync = sixb.getSyncById(params.syncId)
        if (!sync) {
          set.status = 404
          return { error: "Sync not found" }
        }

        return await serializeSync(sixb, sync)
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
      async ({ query, set }) => {
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

          const result = await storage.list({
            projectId: sixb.id,
            syncId: parsed.syncId,
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
      async ({ params, body, set }) => {
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
