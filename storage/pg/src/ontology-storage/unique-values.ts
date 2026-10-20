import {
  uniquePropertyNotPrepared,
  uniqueValueViolation,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  OntologyUniqueValueStorage,
  PreparedUniqueProperty,
  UniqueValueEntry,
} from "@sixb/core/storage"
import type postgres from "postgres"
import type { SQLClient } from "../pg-client"
import { jsonParameter, type PgRootOperation } from "./shared"

type Query = postgres.PendingQuery<postgres.Row[]>

interface PgClaimCounts {
  readonly staged: number | string
  readonly written: number | string
  readonly unprepared_type: string | null
  readonly unprepared_property: string | null
}

/**
 * Gives each candidate value to its object, set-based. `candidates` selects `object_type_id`,
 * `property_id`, `value_key` and `primary_id`, and with `requirePrepared` also the claim's
 * `key_kind` and `key_version`, which must match how the property was prepared.
 *
 * The insert goes first and conflicts do nothing, as the plan writer's statements do: only when
 * it writes fewer rows than it was given does a second query look for the holder to name. A value
 * another object holds, or that two candidates give to different objects, throws
 * `UniqueValueViolationError`; a value already held by its own object is no conflict. A value a
 * concurrent transaction claimed after this one's snapshot fails serialization instead, so the
 * commit retries and then finds it held.
 */
export async function claimPgUniqueValues(
  sql: SQLClient,
  projectId: string,
  candidates: Query,
  options: { readonly requirePrepared: boolean }
): Promise<number> {
  const unprepared = options.requirePrepared
    ? sql`
        SELECT claimed.object_type_id, claimed.property_id
        FROM (
          SELECT DISTINCT object_type_id, property_id, key_kind, key_version FROM candidates
        ) AS claimed
        WHERE NOT EXISTS (
          SELECT 1 FROM object_unique_properties AS prepared
          WHERE prepared.project_id = ${projectId}
            AND prepared.object_type_id = claimed.object_type_id
            AND prepared.property_id = claimed.property_id
            AND prepared.key_kind = claimed.key_kind
            AND prepared.key_version = claimed.key_version
        )
        LIMIT 1
      `
    : sql`SELECT NULL::text AS object_type_id, NULL::text AS property_id WHERE false`

  const [counts] = await sql<PgClaimCounts[]>`
    WITH candidates AS MATERIALIZED (${candidates}),
    unprepared AS (${unprepared}),
    written AS (
      INSERT INTO object_unique_values (
        project_id, object_type_id, property_id, value_hash, value_key, primary_id
      )
      SELECT ${projectId}, object_type_id, property_id,
        sha256(convert_to(value_key, 'UTF8')), value_key, primary_id
      FROM candidates
      WHERE NOT EXISTS (SELECT 1 FROM unprepared)
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT COUNT(*) FROM candidates) AS staged, (SELECT COUNT(*) FROM written) AS written,
      (SELECT object_type_id FROM unprepared) AS unprepared_type,
      (SELECT property_id FROM unprepared) AS unprepared_property
  `

  if (counts?.unprepared_type && counts.unprepared_property) {
    throw uniquePropertyNotPrepared({
      objectTypeId: counts.unprepared_type,
      propertyId: counts.unprepared_property,
    })
  }

  const written = Number(counts?.written ?? 0)
  if (written !== Number(counts?.staged ?? 0)) await assertNoOtherHolder(sql, projectId, candidates)
  return written
}

/** Names a candidate whose value another object holds, now that every candidate was inserted. */
async function assertNoOtherHolder(
  sql: SQLClient,
  projectId: string,
  candidates: Query
): Promise<void> {
  const [conflict] = await sql<
    {
      readonly object_type_id: string
      readonly property_id: string
      readonly holder: string
      readonly claimant: string
    }[]
  >`
    WITH candidates AS MATERIALIZED (${candidates})
    SELECT candidates.object_type_id, candidates.property_id,
      held.primary_id AS holder, candidates.primary_id AS claimant
    FROM candidates
    CROSS JOIN LATERAL (${heldValue(sql, projectId)} LIMIT 1) AS held
    WHERE held.primary_id <> candidates.primary_id
    LIMIT 1
  `
  if (!conflict) return

  throw uniqueValueViolation(
    { objectTypeId: conflict.object_type_id, propertyId: conflict.property_id },
    conflict.holder,
    conflict.claimant
  )
}

/**
 * The stored row of `candidates`' value, by its whole primary key: a lateral lookup per candidate
 * keeps the planner on the index whatever it guesses of the table.
 */
export function heldValue(sql: SQLClient, projectId: string) {
  return sql`
    SELECT stored.primary_id, stored.value_hash
    FROM object_unique_values AS stored
    WHERE stored.project_id = ${projectId}
      AND stored.object_type_id = candidates.object_type_id
      AND stored.property_id = candidates.property_id
      AND stored.value_hash = sha256(convert_to(candidates.value_key, 'UTF8'))
      AND stored.value_key = candidates.value_key
  `
}

export class PgOntologyUniqueValueStorage implements OntologyUniqueValueStorage {
  constructor(private readonly runRootOperation: PgRootOperation) {}

  /**
   * `LOCK TABLE` takes no snapshot, so as the transaction's first statement it waits before the
   * serializable snapshot is taken, and a preparer that waited sees the values the previous one
   * built instead of building them again. An advisory lock would be taken by a `SELECT`, after
   * the snapshot. Only preparation writes this table, so claims, which read it, never wait.
   */
  async lockPreparation(_input: { readonly projectId: string }): Promise<void> {
    await this.runRootOperation(async (sql) => {
      await sql`LOCK TABLE object_unique_properties IN SHARE ROW EXCLUSIVE MODE`
    })
  }

  async listPrepared(input: {
    readonly projectId: string
  }): Promise<readonly PreparedUniqueProperty[]> {
    return this.runRootOperation(async (sql) => {
      const rows = await sql<
        {
          readonly object_type_id: string
          readonly property_id: string
          readonly key_kind: PreparedUniqueProperty["keyKind"]
          readonly key_version: number
        }[]
      >`
        SELECT object_type_id, property_id, key_kind, key_version FROM object_unique_properties
        WHERE project_id = ${input.projectId}
        ORDER BY object_type_id, property_id
      `
      return rows.map((row) => ({
        objectTypeId: row.object_type_id,
        propertyId: row.property_id,
        keyKind: row.key_kind,
        keyVersion: row.key_version,
      }))
    })
  }

  async clear(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly propertyId: string
  }): Promise<void> {
    await this.runRootOperation(async (sql) => {
      await sql`
        DELETE FROM object_unique_values
        WHERE project_id = ${input.projectId} AND object_type_id = ${input.objectTypeId}
          AND property_id = ${input.propertyId}
      `
      await sql`
        DELETE FROM object_unique_properties
        WHERE project_id = ${input.projectId} AND object_type_id = ${input.objectTypeId}
          AND property_id = ${input.propertyId}
      `
    })
  }

  async insert(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly propertyId: string
    readonly entries: readonly UniqueValueEntry[]
  }): Promise<void> {
    await this.runRootOperation((sql) =>
      claimPgUniqueValues(
        sql,
        input.projectId,
        sql`
          SELECT ${input.objectTypeId}::text AS object_type_id,
            ${input.propertyId}::text AS property_id,
            entry->>'valueKey' AS value_key, entry->>'primaryId' AS primary_id
          FROM jsonb_array_elements(${jsonParameter(sql, input.entries)}::jsonb) AS entry
        `,
        // The values are being prepared: nothing to require yet.
        { requirePrepared: false }
      )
    )
  }

  async markPrepared(
    input: PreparedUniqueProperty & { readonly projectId: string; readonly preparedAt: string }
  ): Promise<void> {
    await this.runRootOperation(async (sql) => {
      await sql`
        INSERT INTO object_unique_properties (
          project_id, object_type_id, property_id, key_kind, key_version, prepared_at
        ) VALUES (
          ${input.projectId}, ${input.objectTypeId}, ${input.propertyId}, ${input.keyKind},
          ${input.keyVersion}, ${input.preparedAt}::timestamptz
        )
        ON CONFLICT (project_id, object_type_id, property_id)
        DO UPDATE SET key_kind = EXCLUDED.key_kind, key_version = EXCLUDED.key_version,
          prepared_at = EXCLUDED.prepared_at
      `
    })
  }
}
