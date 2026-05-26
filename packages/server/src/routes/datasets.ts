import type { DatasetDefinition, DatasetVersion, OntologySource, Pario } from "@pario/core"
import type { Elysia } from "elysia"
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
import { handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"

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

function getDatasetReferences(pario: Pario<readonly OntologySource[]>, datasetId: string) {
  const pipelines = pario.getPipelineDefinitions()
  const projections = [...pario.getObjectProjections(), ...pario.getLinkProjections()]

  const syncIds = pario
    .getSyncDefinitions()
    .filter((sync) => sync.target.dataset.id === datasetId)
    .map((sync) => sync.id)

  const sourcePipelineIds = pipelines
    .filter((pipeline) =>
      pipeline.graph.nodes.some((node) =>
        Object.values(node.step.inputs).some((input) => input.id === datasetId)
      )
    )
    .map((pipeline) => pipeline.id)

  const targetPipelineIds = pipelines
    .filter((pipeline) => pipeline.graph.nodes.some((node) => node.step.output.id === datasetId))
    .map((pipeline) => pipeline.id)

  const projectionIds = projections
    .filter((projection) => projection.datasetId === datasetId)
    .map((projection) => projection.id)

  return {
    syncIds,
    sourcePipelineIds,
    targetPipelineIds,
    projectionIds,
  }
}

async function serializeDatasetCatalogItem(
  pario: Pario<readonly OntologySource[]>,
  dataset: DatasetDefinition
) {
  const [storedDataset, latestVersion] = await Promise.all([
    pario.lakeStorage.getDataset(dataset.id),
    pario.lakeStorage.getLatestVersion(dataset.id),
  ])

  return serializeDatasetCatalogItemFromState(pario, dataset, {
    materialized: storedDataset !== null,
    latestVersion,
  })
}

async function serializeDatasetCatalogItems(pario: Pario<readonly OntologySource[]>) {
  const storedDatasets = new Set(
    (await pario.lakeStorage.listDatasets()).map((dataset) => dataset.id)
  )

  return Promise.all(
    pario.getDatasetDefinitions().map(async (dataset) => {
      const materialized = storedDatasets.has(dataset.id)
      const latestVersion = materialized
        ? await pario.lakeStorage.getLatestVersion(dataset.id)
        : null

      return serializeDatasetCatalogItemFromState(pario, dataset, {
        materialized,
        latestVersion,
      })
    })
  )
}

function serializeDatasetCatalogItemFromState(
  pario: Pario<readonly OntologySource[]>,
  dataset: DatasetDefinition,
  state: {
    readonly materialized: boolean
    readonly latestVersion: DatasetVersion | null
  }
) {
  return DatasetCatalogItemSchema.parse({
    ...dataset,
    materialized: state.materialized,
    latestVersion: state.latestVersion ? serializeDatasetVersion(state.latestVersion) : null,
    ...getDatasetReferences(pario, dataset.id),
  })
}

function requireDataset(pario: Pario<readonly OntologySource[]>, datasetId: string) {
  const dataset = pario.getDatasetById(datasetId)
  if (!dataset) {
    throw new Error("Dataset not found")
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

export function registerDatasetRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app
    .get(
      "/api/datasets",
      async ({ set }) => {
        try {
          return await serializeDatasetCatalogItems(pario)
        } catch (error) {
          set.status = 400
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      {
        response: { 200: DatasetCatalogItemSchema.array(), 400: ErrorResponseSchema },
        detail: {
          summary: "List registered datasets",
          tags: ["Datasets"],
          operationId: "listDatasets",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId",
      async ({ params, set }) => {
        try {
          const dataset = requireDataset(pario, params.datasetId)
          return await serializeDatasetCatalogItem(pario, dataset)
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
          tags: ["Datasets"],
          operationId: "getDataset",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId/versions",
      async ({ params, query, set }) => {
        try {
          requireDataset(pario, params.datasetId)
          const parsed = DatasetVersionsQuerySchema.parse(query)
          const limit = parseLimit(parsed.limit, DEFAULT_VERSION_LIMIT, MAX_VERSION_LIMIT)
          const versions = await pario.lakeStorage.listVersions(params.datasetId, limit)

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
          tags: ["Datasets"],
          operationId: "listDatasetVersions",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId/versions/:versionId",
      async ({ params, set }) => {
        try {
          requireDataset(pario, params.datasetId)
          const version = await pario.lakeStorage.getVersion(params.datasetId, params.versionId)
          if (!version) {
            set.status = 404
            return { error: "Dataset version not found" }
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
          tags: ["Datasets"],
          operationId: "getDatasetVersion",
        },
      }
    )
    .get(
      "/api/datasets/:datasetId/rows",
      async ({ params, query, set }) => {
        try {
          requireDataset(pario, params.datasetId)
          const parsed = DatasetRowsQuerySchema.parse(query)
          const limit = parseLimit(parsed.limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT)
          const offset = parseOffset(parsed.offset)
          const version = parsed.versionId
            ? await pario.lakeStorage.getVersion(params.datasetId, parsed.versionId)
            : await pario.lakeStorage.getLatestVersion(params.datasetId)

          if (!version) {
            set.status = 404
            return { error: "Dataset version not found" }
          }

          const requestedColumns = parseColumns(parsed.columns)
          const columns = resolveColumns(version, requestedColumns)
          const rows = await collectRows(
            pario.lakeStorage.readRows({
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
          tags: ["Datasets"],
          operationId: "listDatasetRows",
        },
      }
    )
}
