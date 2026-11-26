import type {
  ListObjectEditsInput,
  OntologyTypeShapeStorage,
  StoredObjectEdit,
  StoredTypeShape,
  TypeShape,
  TypeShapeProbeInput,
  TypeShapeWrite,
} from "@sixb/core/storage"
import type postgres from "postgres"
import type { SQLClient } from "../pg-client"
import { jsonParameter, type PgRootOperation, toIsoString } from "./shared"
import { liveSourceRowsJoin, PUBLISHED } from "./source-roots"

type Query = postgres.PendingQuery<postgres.Row[]>

interface PgTypeShapeRow {
  readonly object_type_id: string
  readonly shape: TypeShape
  readonly previous_shape: TypeShape | null
  readonly state: StoredTypeShape["state"]
  readonly updated_at: Date | string
}

interface PgObjectEditRow {
  readonly primary_id: string
  readonly value: StoredObjectEdit["value"]
  readonly edited_at: Readonly<Record<string, string>>
}

export class PgOntologyTypeShapeStorage implements OntologyTypeShapeStorage {
  constructor(private readonly runRootOperation: PgRootOperation) {}

  /**
   * As the transaction's first statement, `LOCK TABLE` waits before any snapshot is taken, so a
   * recorder that waited reads what the previous one wrote. Only recording writes this table, so
   * the roles that only read it never wait.
   */
  async lock(_input: { readonly projectId: string }): Promise<void> {
    await this.runRootOperation(async (sql) => {
      await sql`LOCK TABLE ontology_type_shapes IN SHARE ROW EXCLUSIVE MODE`
    })
  }

  async list(input: { readonly projectId: string }): Promise<readonly StoredTypeShape[]> {
    return this.runRootOperation(async (sql) => {
      const rows = await sql<PgTypeShapeRow[]>`
        SELECT object_type_id, shape, previous_shape, state, updated_at FROM ontology_type_shapes
        WHERE project_id = ${input.projectId}
        ORDER BY object_type_id
      `
      return rows.map((row) => ({
        objectTypeId: row.object_type_id,
        shape: row.shape,
        previous: row.previous_shape,
        state: row.state,
        updatedAt: toIsoString(row.updated_at),
      }))
    })
  }

  async write(input: TypeShapeWrite): Promise<void> {
    await this.runRootOperation(async (sql) => {
      await sql`
        INSERT INTO ontology_type_shapes (
          project_id, object_type_id, shape, previous_shape, state, updated_at
        )
        VALUES (
          ${input.projectId}, ${input.objectTypeId}, ${jsonParameter(sql, input.shape)}::jsonb,
          ${input.previous === null ? null : jsonParameter(sql, input.previous)}::jsonb,
          'current', ${input.updatedAt}::timestamptz
        )
        ON CONFLICT (project_id, object_type_id)
        DO UPDATE SET
          shape = EXCLUDED.shape,
          previous_shape = EXCLUDED.previous_shape,
          updated_at = EXCLUDED.updated_at
      `
    })
  }

  async remove(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<void> {
    await this.runRootOperation(async (sql) => {
      await sql`
        DELETE FROM ontology_type_shapes
        WHERE project_id = ${input.projectId} AND object_type_id = ${input.objectTypeId}
      `
    })
  }

  /**
   * One `EXISTS` per store, joined by `OR`: Postgres evaluates them left to right and stops at
   * the first that finds a row. `objects.properties` has no GIN index, so a key nobody holds
   * scans the type's partition.
   */
  async holds(input: TypeShapeProbeInput): Promise<boolean> {
    return this.runRootOperation(async (sql) => {
      const exists = probeHolders(sql, input).reduce<Query | null>(
        (query, holder) => (query ? sql`${query} OR EXISTS (${holder})` : sql`EXISTS (${holder})`),
        null
      )

      const [row] = await sql<{ readonly held: boolean }[]>`SELECT (${exists!}) AS held`
      return row?.held === true
    })
  }

  async count(input: TypeShapeProbeInput): Promise<number> {
    return this.runRootOperation(async (sql) => {
      const union = probeHolders(sql, input).reduce<Query | null>(
        (query, holder) => (query ? sql`${query} UNION ${holder}` : holder),
        null
      )

      const [row] = await sql<{ readonly count: string | number }[]>`
        SELECT count(*) AS count FROM (${union!}) AS holders
      `
      return Number(row?.count ?? 0)
    })
  }

  async listHeldKeys(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<{
    readonly linkIds: readonly string[]
    readonly seriesPropertyIds: readonly string[]
  }> {
    return this.runRootOperation(async (sql) => {
      const { projectId, objectTypeId: type } = input
      const links = await sql<{ readonly link_id: string }[]>`
        SELECT link_id FROM links WHERE project_id = ${projectId} AND source_type_id = ${type}
        UNION
        SELECT link_id FROM ontology_link_overrides
        WHERE project_id = ${projectId} AND identity_kind IN ('edge', 'slot')
          AND source_type_id = ${type}
        UNION
        SELECT rows.link_id FROM ontology_source_rows AS rows
        ${liveSourceRowsJoin(sql, projectId)}
        WHERE rows.entity_kind = 'link' AND rows.source_type_id = ${type}
        ORDER BY 1
      `
      const series = await sql<{ readonly property_id: string }[]>`
        SELECT DISTINCT property_id FROM timeseries_latest
        WHERE project_id = ${projectId} AND object_type_id = ${type}
        ORDER BY 1
      `

      return {
        linkIds: links.map((row) => row.link_id),
        seriesPropertyIds: series.map((row) => row.property_id),
      }
    })
  }

  async listEdits(input: ListObjectEditsInput): Promise<{
    readonly edits: readonly StoredObjectEdit[]
    readonly nextPrimaryId?: string
  }> {
    return this.runRootOperation(async (sql) => {
      const key = input.withValueOf
      const rows = await sql<PgObjectEditRow[]>`
        SELECT primary_id, value, edited_at FROM ontology_object_overrides
        WHERE project_id = ${input.projectId} AND object_type_id = ${input.objectTypeId}
          AND value ->> 'kind' IN ('create', 'patch')
          ${key === undefined ? sql`` : sql`AND (value -> 'properties' ? ${key} OR value -> 'set' ? ${key})`}
          ${input.afterPrimaryId === undefined ? sql`` : sql`AND primary_id > ${input.afterPrimaryId}`}
        ORDER BY primary_id
        LIMIT ${input.limit + 1}
      `

      const edits = rows.slice(0, input.limit).map((row) => ({
        primaryId: row.primary_id,
        value: row.value,
        editedAt: row.edited_at,
      }))
      if (rows.length <= input.limit) return { edits }

      return { edits, nextPrimaryId: edits.at(-1)!.primaryId }
    })
  }
}

/**
 * One query per store the probe reads, each selecting the primary id of an object it finds: the
 * source object's, for a link. `holds` asks whether any returns a row, `count` counts them all.
 */
function probeHolders(sql: SQLClient, input: TypeShapeProbeInput): Query[] {
  const { projectId, objectTypeId: type, probe } = input
  const ofType = sql`project_id = ${projectId} AND object_type_id = ${type}`

  switch (probe.kind) {
    case "property": {
      const key = probe.propertyId
      return [
        sql`SELECT primary_id FROM objects WHERE ${ofType} AND properties ? ${key}`,
        sql`
          SELECT primary_id FROM ontology_object_overrides
          WHERE ${ofType} AND (value -> 'properties' ? ${key} OR value -> 'set' ? ${key}
            OR value -> 'unset' ? ${key} OR edited_at ? ${key})
        `,
        sql`
          SELECT rows.primary_id FROM ontology_source_rows AS rows
          ${liveSourceRowsJoin(sql, projectId)}
          WHERE rows.entity_kind = 'object' AND rows.object_type_id = ${type}
            AND (rows.payload -> 'properties' ? ${key}
              OR rows.payload -> 'absentSourcePropertyIds' ? ${key})
        `,
        sql`SELECT object_id FROM timeseries_latest WHERE ${ofType} AND property_id = ${key}`,
      ]
    }

    case "missingRequired": {
      const key = probe.propertyId
      return [
        // An object created by an edit has no live source row: its root key is its own.
        sql`
          SELECT edits.primary_id FROM ontology_object_overrides AS edits
          WHERE edits.project_id = ${projectId} AND edits.object_type_id = ${type}
            AND edits.value ->> 'kind' = 'create'
            AND NOT (edits.value -> 'properties' ? ${key})
            AND NOT EXISTS (
              SELECT 1 FROM ontology_source_roots AS roots
              JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
                AND versions.status IN ${sql.unsafe(PUBLISHED)}
              WHERE roots.project_id = ${projectId} AND roots.retired_at IS NULL
                AND NOT roots.deleted
                AND roots.root_key = '["object",' || to_jsonb(edits.object_type_id)::text
                  || ',' || to_jsonb(edits.primary_id)::text || ']'
            )
        `,
        // An edit that cleared the value, on any object: it wins unless a newer source does.
        sql`
          SELECT primary_id FROM ontology_object_overrides
          WHERE ${ofType} AND value ->> 'kind' = 'patch' AND value -> 'unset' ? ${key}
        `,
      ]
    }

    case "link":
      return linkHolders(sql, projectId, type, sql`AND link_id = ${probe.linkId}`)

    case "type":
      return [
        sql`SELECT primary_id FROM objects WHERE ${ofType}`,
        sql`SELECT primary_id FROM ontology_object_overrides WHERE ${ofType}`,
        sql`
          SELECT rows.primary_id FROM ontology_source_rows AS rows
          ${liveSourceRowsJoin(sql, projectId)}
          WHERE rows.entity_kind = 'object' AND rows.object_type_id = ${type}
        `,
        sql`SELECT object_id FROM timeseries_latest WHERE ${ofType}`,
        ...linkHolders(sql, projectId, type, sql``),
      ]
  }
}

/** Links, link edits of either identity and any kind, and live source link rows of the type. */
function linkHolders(sql: SQLClient, projectId: string, type: string, linkFilter: Query): Query[] {
  return [
    sql`
      SELECT source_id FROM links
      WHERE project_id = ${projectId} AND source_type_id = ${type} ${linkFilter}
    `,
    sql`
      SELECT source_primary_id FROM ontology_link_overrides
      WHERE project_id = ${projectId} AND identity_kind IN ('edge', 'slot')
        AND source_type_id = ${type} ${linkFilter}
    `,
    sql`
      SELECT rows.source_primary_id FROM ontology_source_rows AS rows
      ${liveSourceRowsJoin(sql, projectId)}
      WHERE rows.entity_kind = 'link' AND rows.source_type_id = ${type} ${linkFilter}
    `,
  ]
}
