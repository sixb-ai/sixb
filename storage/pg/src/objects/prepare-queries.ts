import { createHash } from "node:crypto"
import type { ObjectQueryIndexDefinition } from "@sixb/core"
import type { ObjectQueryPreparationPlan, ObjectQueryPreparationResult } from "@sixb/core/storage"
import type { ReservedSQL, SQL, SQLClient } from "../pg-client"
import { undoOnFailure, withReservedPgConnection } from "../transactions"
import { lockPgPreparation } from "./preparation-lock"
import { ensurePgObjectQueryIndexes, type PgObjectQueryIndex } from "./query-indexes"
import { type PgObjectTextCountIndex, preparePgObjectTextCounts } from "./text-count-index"

/** Reconcile ontology indexes and text columns once per plan, coordinating concurrent startups. */
export async function preparePgObjectQueries(
  sql: SQL,
  schema: string,
  plan: ObjectQueryPreparationPlan
): Promise<ObjectQueryPreparationResult> {
  const fingerprint = preparationFingerprint(plan)
  const current = await readCompletedPreparation(sql, fingerprint)
  if (current) return current

  // Hold one session through the entire preparation, including CONCURRENTLY builds (which
  // cannot run in a transaction). Helpers reuse it instead of taking another pool connection.
  return withReservedPgConnection(sql, async (connection) => {
    const key = `${schema}.objects.query-indexes`
    await lockPgPreparation(connection, key)
    const unlock = () => connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`
    const result = await undoOnFailure(async () => {
      const existing = await readCompletedPreparation(connection, fingerprint)
      if (existing) return existing

      console.info(
        `[SixbPg] Preparing query indexes for ${plan.projectId}; initial backfills may block writes.`
      )
      const result = await prepareStructures(connection, schema, plan)

      // Record completion only after every index and generated-column backfill succeeds.
      await connection`
        INSERT INTO object_query_preparation (singleton, fingerprint, result)
        VALUES (true, ${fingerprint}, ${connection.json({ ...result, warnings: [...result.warnings] })})
        ON CONFLICT (singleton) DO UPDATE
        SET fingerprint = excluded.fingerprint, result = excluded.result, prepared_at = now()
      `
      return result
    }, unlock)
    await unlock()

    return result
  })
}

function preparationFingerprint(plan: ObjectQueryPreparationPlan): string {
  const objectTypes = plan.objectTypes
    .map((type) => ({
      objectTypeId: type.objectTypeId,
      properties: [...type.properties].sort((a, b) => a.propertyId.localeCompare(b.propertyId)),
      indexes: type.indexes
        .map(normalizeIndex)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }))
    .sort((a, b) => a.objectTypeId.localeCompare(b.objectTypeId))

  // Bump the version when physical generation changes, even if the ontology stays the same.
  const definition = { version: 1, projectId: plan.projectId, objectTypes }
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex")
}

function normalizeIndex(index: ObjectQueryIndexDefinition) {
  if (index.kind === "sort") {
    return {
      kind: index.kind,
      fields: index.fields.map((field) => ({
        propertyId: field.propertyId,
        direction: field.direction ?? "asc",
      })),
      filters: index.filters ?? [],
    }
  }

  return {
    kind: index.kind,
    propertyId: index.propertyId,
    filters: [...(index.filters ?? [])].sort(),
  }
}

async function readCompletedPreparation(
  sql: SQLClient,
  fingerprint: string
): Promise<ObjectQueryPreparationResult | undefined> {
  const [row] = await sql<{ result: ObjectQueryPreparationResult }[]>`
    SELECT result FROM object_query_preparation
    WHERE singleton AND fingerprint = ${fingerprint}
  `
  if (!row) return undefined

  return { ...row.result, status: "current" }
}

async function prepareStructures(
  sql: ReservedSQL,
  schema: string,
  plan: ObjectQueryPreparationPlan
): Promise<ObjectQueryPreparationResult> {
  const { indexes, textCounts, warnings } = compilePreparationPlan(plan)

  if (indexes.some((index) => index.kind === "text") || textCounts.length > 0) {
    await ensureTrigrams(sql)
  }

  const names = await ensurePgObjectQueryIndexes(sql, schema, indexes)
  const texts = await preparePgObjectTextCounts(sql, schema, textCounts)
  return {
    status: "prepared",
    objectTypes: plan.objectTypes.length,
    indexes: new Set([...names, ...texts]).size,
    warnings,
  }
}

function compilePreparationPlan(plan: ObjectQueryPreparationPlan) {
  const indexes: PgObjectQueryIndex[] = []
  const textCounts: PgObjectTextCountIndex[] = []
  const warnings: string[] = []

  for (const type of plan.objectTypes) {
    const scope = { projectId: plan.projectId, objectTypeId: type.objectTypeId }
    indexes.push({ ...scope, kind: "incomingLinks" })

    for (const property of type.properties) {
      if (property.text) indexes.push({ ...scope, kind: "text", propertyId: property.propertyId })
      if (property.sortable) {
        indexes.push({
          ...scope,
          kind: "sort",
          fields: [{ propertyId: property.propertyId, scalarKind: property.scalarKind }],
        })
      }

      if (property.filterable && property.scalarKind === "string") {
        indexes.push({ ...scope, kind: "filter", properties: [property.propertyId] })
      } else if (
        property.filterable &&
        property.scalarKind &&
        ["integer", "double", "boolean", "date", "timestamp", "uuid"].includes(property.scalarKind)
      ) {
        indexes.push({ ...scope, kind: "value", propertyId: property.propertyId })
      } else if (property.filterable) {
        warnings.push(
          `${type.objectTypeId}.${property.propertyId}: no dedicated equality index for ${property.scalarKind ?? "this schema"}; queries remain exact through the general path.`
        )
      }
    }

    for (const index of type.indexes) {
      if (index.kind === "sort") {
        indexes.push({
          ...scope,
          kind: "sort",
          equality: index.filters,
          fields: index.fields.map((field) => ({
            ...field,
            scalarKind: type.properties.find((property) => property.propertyId === field.propertyId)
              ?.scalarKind,
          })),
        })
      } else {
        textCounts.push({ ...scope, propertyId: index.propertyId, filters: index.filters })
      }
    }
  }
  return { indexes, textCounts, warnings }
}

// Extension creation is database-wide, whereas index preparation is schema-scoped.
async function ensureTrigrams(sql: ReservedSQL): Promise<void> {
  await lockPgPreparation(sql, "sixb.extension.pg_trgm")
  const unlock = () => sql`SELECT pg_advisory_unlock(hashtextextended('sixb.extension.pg_trgm', 0))`
  await undoOnFailure(async () => {
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
  }, unlock)
  await unlock()
}
