import type { DatasetDefinition, OntologySource, Sixb } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import type {
  DatasetCatalogState,
  DatasetLatestVersionSummary,
  DatasetVersion,
} from "@sixb/core/lake-storage"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  DatasetCatalogItemSchema,
  DatasetParamsSchema,
  DatasetRowsQuerySchema,
  DatasetRowsResponseSchema,
  DatasetVersionListResponseSchema,
  DatasetVersionParamsSchema,
  DatasetVersionSchema,
  DatasetVersionsQuerySchema,
} from "../schemas/datasets"
import { errorResponse, handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"

const DEFAULT_VERSION_LIMIT = 20
const MAX_VERSION_LIMIT = 100
const DEFAULT_ROW_LIMIT = 100
const MAX_ROW_LIMIT = 1_000

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  const parsed = parseOptionalInt(value) ?? fallback
  if (parsed < 0) {
    throw new Error("Limit must be greater than or equal to 0")
  }
  return Math.min(parsed, max)
}

function parseOffset(value: string | undefined): number {
  const parsed = parseOptionalInt(value) ?? 0
  if (parsed < 0) {
    throw new Error("Offset must be greater than or equal to 0")
  }
  return parsed
}

function serializeDatasetVersion(version: DatasetVersion) {
  return DatasetVersionSchema.parse({
    datasetId: version.datasetId,
    versionId: version.versionId,
    parentVersionId: version.parentVersionId,
    mode: version.mode,
    createdAt: toIsoString(version.createdAt),
    schema: version.schema,
    producer: version.producer,
    inputs: version.inputs,
    rowCount: version.rowCount,
    sizeBytes: version.sizeBytes,
  })
}

interface DatasetReferences {
  readonly syncIds: string[]
  readonly sourcePipelineIds: string[]
  readonly targetPipelineIds: string[]
  readonly projectionIds: string[]
}

const EMPTY_DATASET_REFERENCES: DatasetReferences = {
  syncIds: [],
  sourcePipelineIds: [],
  targetPipelineIds: [],
  projectionIds: [],
}

/**
 * Index dataset references in a single pass so the catalog routes never rescan
 * syncs, pipelines, and projections once per dataset.
 */
function buildDatasetReferenceIndex(
  sixb: Sixb<readonly OntologySource[]>,
  scoped: ReturnType<typeof requestAuthState>["scoped"] = null
): Map<string, DatasetReferences> {
  const index = new Map<string, DatasetReferences>()
  const referencesFor = (datasetId: string): DatasetReferences => {
    let references = index.get(datasetId)
    if (!references) {
      references = { syncIds: [], sourcePipelineIds: [], targetPipelineIds: [], projectionIds: [] }
      index.set(datasetId, references)
    }
    return references
  }

  for (const sync of scoped ? scoped.listSyncs() : sixb.listSyncs()) {
    referencesFor(sync.target.dataset.id).syncIds.push(sync.id)
  }

  for (const pipeline of scoped ? scoped.listPipelines() : sixb.listPipelines()) {
    const sourceDatasetIds = new Set<string>()
    const targetDatasetIds = new Set<string>()
    for (const node of pipeline.graph.nodes) {
      for (const input of Object.values(node.step.inputs)) {
        sourceDatasetIds.add(input.id)
      }
      targetDatasetIds.add(node.step.output.id)
    }
    for (const datasetId of sourceDatasetIds) {
      referencesFor(datasetId).sourcePipelineIds.push(pipeline.id)
    }
    for (const datasetId of targetDatasetIds) {
      referencesFor(datasetId).targetPipelineIds.push(pipeline.id)
    }
  }

  // Projections inherit dataset visibility: a scoped caller sees a
  // projection's lineage only when it can view the projection's source
  // dataset. Privileged callers (no scoped runtime) see them all.
  for (const projection of [
    ...sixb.listObjectProjections(),
    ...sixb.listLinkProjections(),
    ...sixb.listTelemetryProjections(),
  ]) {
    if (!scoped || scoped.getDatasetById(projection.datasetId)) {
      referencesFor(projection.datasetId).projectionIds.push(projection.id)
    }
  }

  return index
}

function serializeLatestVersionSummary(summary: DatasetLatestVersionSummary) {
  return {
    datasetId: summary.datasetId,
    versionId: summary.versionId,
    mode: summary.mode,
    createdAt: toIsoString(summary.createdAt),
    rowCount: summary.rowCount,
  }
}

function serializeDatasetCatalogItem(
  dataset: DatasetDefinition,
  state: DatasetCatalogState | undefined,
  references: DatasetReferences
) {
  return DatasetCatalogItemSchema.parse({
    ...dataset,
    materialized: state?.materialized ?? false,
    latestVersion: state?.latestVersion ? serializeLatestVersionSummary(state.latestVersion) : null,
    syncIds: references.syncIds,
    sourcePipelineIds: references.sourcePipelineIds,
    targetPipelineIds: references.targetPipelineIds,
    projectionIds: references.projectionIds,
  })
}

async function serializeDatasetCatalogItems(
  sixb: Sixb<readonly OntologySource[]>,
  definitions: readonly DatasetDefinition[],
  scoped: ReturnType<typeof requestAuthState>["scoped"] = null
) {
  const references = buildDatasetReferenceIndex(sixb, scoped)
  const states = await sixb.lakeStorage.listDatasetCatalogState(definitions.map((d) => d.id))
  const stateByDatasetId = new Map(states.map((state) => [state.datasetId, state]))

  return definitions.map((definition) =>
    serializeDatasetCatalogItem(
      definition,
      stateByDatasetId.get(definition.id),
      references.get(definition.id) ?? EMPTY_DATASET_REFERENCES
    )
  )
}

function requireDataset(
  sixb: Sixb<readonly OntologySource[]>,
  scoped: ReturnType<typeof requestAuthState>["scoped"],
  datasetId: string
) {
  const dataset = scoped ? scoped.getDatasetById(datasetId) : sixb.getDatasetById(datasetId)
  if (!dataset) {
    throw new SixbError("dataset.not_found", "Dataset not found")
  }
  return dataset
}

function parseColumns(value: string | undefined): readonly string[] | undefined {
  if (!value) return undefined

  const columns = value
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)

  return columns.length > 0 ? columns : undefined
}

function resolveColumns(version: DatasetVersion, requested: readonly string[] | undefined) {
  const available = new Set(version.schema.columns.map((column) => column.name))
  const selected = requested ?? version.schema.columns.map((column) => column.name)

  for (const column of selected) {
    if (!available.has(column)) {
      throw new Error(
        `Dataset '${version.datasetId}' does not have column '${column}' at version '${version.versionId}'`
      )
    }
  }

  return selected
}

async function collectRows(rows: AsyncIterable<Readonly<Record<string, unknown>>>) {
  const collected: Record<string, unknown>[] = []
  for await (const row of rows) {
    collected.push({ ...row })
  }
  return collected
}

export function registerDatasetRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/datasets",
      async (context) => {
        const { set } = context
        const { scoped } = requestAuthState(context)
        try {
          const definitions = scoped ? scoped.listDatasets() : sixb.listDatasets()
          return await serializeDatasetCatalogItems(sixb, definitions, scoped)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        response: { 200: DatasetCatalogItemSchema.array(), 400: ErrorResponseSchema },
        detail: {
          summary: "List registered datasets",
          tags: [OPENAPI_TAGS.datasets.name],
          operationId: "listDatasets",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId",
      async (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)
        try {
          const dataset = requireDataset(sixb, scoped, params.datasetId)
          const [state] = await sixb.lakeStorage.listDatasetCatalogState([dataset.id])
          const references = buildDatasetReferenceIndex(sixb, scoped).get(dataset.id)
          return serializeDatasetCatalogItem(dataset, state, references ?? EMPTY_DATASET_REFERENCES)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: DatasetParamsSchema,
        response: {
          200: DatasetCatalogItemSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get dataset metadata",
          tags: [OPENAPI_TAGS.datasets.name],
          operationId: "getDataset",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId/versions",
      async (context) => {
        const { params, query, set } = context
        const { scoped } = requestAuthState(context)
        try {
          requireDataset(sixb, scoped, params.datasetId)
          const parsed = DatasetVersionsQuerySchema.parse(query)
          const limit = parseLimit(parsed.limit, DEFAULT_VERSION_LIMIT, MAX_VERSION_LIMIT)
          const versions = await sixb.lakeStorage.listVersions(params.datasetId, limit)

          return DatasetVersionListResponseSchema.parse({
            versions: versions.map(serializeDatasetVersion),
            count: versions.length,
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: DatasetParamsSchema,
        query: DatasetVersionsQuerySchema,
        response: {
          200: DatasetVersionListResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "List dataset versions",
          tags: [OPENAPI_TAGS.datasetVersions.name],
          operationId: "listDatasetVersions",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId/versions/:versionId",
      async (context) => {
        const { params, set } = context
        const { scoped } = requestAuthState(context)
        try {
          requireDataset(sixb, scoped, params.datasetId)
          const version = await sixb.lakeStorage.getVersion(params.datasetId, params.versionId)
          if (!version) {
            return errorResponse(set, "dataset.version_not_found", "Dataset version not found")
          }

          return serializeDatasetVersion(version)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: DatasetVersionParamsSchema,
        response: {
          200: DatasetVersionSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get dataset version",
          tags: [OPENAPI_TAGS.datasetVersions.name],
          operationId: "getDatasetVersion",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId/rows",
      async (context) => {
        const { params, query, set } = context
        const { scoped } = requestAuthState(context)
        try {
          requireDataset(sixb, scoped, params.datasetId)
          const parsed = DatasetRowsQuerySchema.parse(query)
          const limit = parseLimit(parsed.limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT)
          const offset = parseOffset(parsed.offset)
          const version = parsed.versionId
            ? await sixb.lakeStorage.getVersion(params.datasetId, parsed.versionId)
            : await sixb.lakeStorage.getLatestVersion(params.datasetId)

          if (!version) {
            return errorResponse(set, "dataset.version_not_found", "Dataset version not found")
          }

          const requestedColumns = parseColumns(parsed.columns)
          const columns = resolveColumns(version, requestedColumns)
          const rows = await collectRows(
            sixb.lakeStorage.readRows({
              datasetId: params.datasetId,
              versionId: version.versionId,
              columns: requestedColumns,
              limit,
              offset,
            })
          )
          const hasMore =
            version.rowCount === undefined
              ? rows.length === limit
              : offset + rows.length < version.rowCount

          return DatasetRowsResponseSchema.parse({
            datasetId: params.datasetId,
            versionId: version.versionId,
            version: serializeDatasetVersion(version),
            columns: [...columns],
            rows,
            count: rows.length,
            limit,
            offset,
            total: version.rowCount,
            hasMore,
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: DatasetParamsSchema,
        query: DatasetRowsQuerySchema,
        response: {
          200: DatasetRowsResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Preview dataset rows",
          tags: [OPENAPI_TAGS.datasetRows.name],
          operationId: "listDatasetRows",
        },
      }
    )
}
