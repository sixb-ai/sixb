import type { Database, SQLQueryBindings } from "bun:sqlite"
import type {
  ListObjectEditsInput,
  OntologyTypeShapeStorage,
  StoredObjectEdit,
  StoredTypeShape,
  TypeShapeProbeInput,
  TypeShapeWrite,
} from "@sixb/core/storage"
import type { SqliteRootOperation } from "./shared"
import { LIVE_SOURCE_ROWS_JOIN, PUBLISHED } from "./source-roots"

/** One store's query and its parameters, selecting the primary id of each object it finds. */
interface Holder {
  readonly sql: string
  readonly params: readonly SQLQueryBindings[]
}

interface SqliteTypeShapeRow {
  readonly object_type_id: string
  readonly shape: string
  readonly previous_shape: string | null
  readonly state: StoredTypeShape["state"]
  readonly updated_at: string
}

export class SqliteOntologyTypeShapeStorage implements OntologyTypeShapeStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  /** SQLite write transactions already run one at a time. */
  async lock(_input: { readonly projectId: string }): Promise<void> {}

  async list(input: { readonly projectId: string }): Promise<readonly StoredTypeShape[]> {
    return this.runRootOperation(() => {
      const rows = this.db
        .query(
          `SELECT object_type_id, shape, previous_shape, state, updated_at FROM ontology_type_shapes
           WHERE project_id = ? ORDER BY object_type_id`
        )
        .all(input.projectId) as SqliteTypeShapeRow[]

      return rows.map((row) => ({
        objectTypeId: row.object_type_id,
        shape: JSON.parse(row.shape),
        previous: row.previous_shape === null ? null : JSON.parse(row.previous_shape),
        state: row.state,
        updatedAt: row.updated_at,
      }))
    })
  }

  async write(input: TypeShapeWrite): Promise<void> {
    await this.runRootOperation(() => {
      this.db
        .query(
          `INSERT INTO ontology_type_shapes
             (project_id, object_type_id, shape, previous_shape, state, updated_at)
           VALUES (?, ?, ?, ?, 'current', ?)
           ON CONFLICT (project_id, object_type_id)
           DO UPDATE SET
             shape = excluded.shape,
             previous_shape = excluded.previous_shape,
             updated_at = excluded.updated_at`
        )
        .run(
          input.projectId,
          input.objectTypeId,
          JSON.stringify(input.shape),
          input.previous === null ? null : JSON.stringify(input.previous),
          input.updatedAt
        )
    })
  }

  async remove(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<void> {
    await this.runRootOperation(() => {
      this.db
        .query("DELETE FROM ontology_type_shapes WHERE project_id = ? AND object_type_id = ?")
        .run(input.projectId, input.objectTypeId)
    })
  }

  /** One `EXISTS` per store, joined by `OR`, which SQLite stops evaluating at the first hit. */
  async holds(input: TypeShapeProbeInput): Promise<boolean> {
    return this.runRootOperation(() => {
      const holders = probeHolders(input)
      const sql = holders.map((holder) => `EXISTS (${holder.sql})`).join(" OR ")

      const row = this.db
        .query(`SELECT (${sql}) AS held`)
        .get(...holders.flatMap((holder) => holder.params)) as { readonly held: number }
      return row.held === 1
    })
  }

  async count(input: TypeShapeProbeInput): Promise<number> {
    return this.runRootOperation(() => {
      const holders = probeHolders(input)
      const union = holders.map((holder) => holder.sql).join(" UNION ")

      const row = this.db
        .query(`SELECT count(*) AS count FROM (${union})`)
        .get(...holders.flatMap((holder) => holder.params)) as { readonly count: number }
      return row.count
    })
  }

  async listHeldKeys(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<{
    readonly linkIds: readonly string[]
    readonly seriesPropertyIds: readonly string[]
  }> {
    return this.runRootOperation(() => {
      const { projectId, objectTypeId: type } = input
      const links = this.db
        .query(
          `SELECT link_id FROM links WHERE project_id = ? AND source_type_id = ?
           UNION
           SELECT link_id FROM ontology_link_overrides
           WHERE project_id = ? AND identity_kind IN ('edge', 'slot') AND source_type_id = ?
           UNION
           SELECT rows.link_id FROM ontology_source_rows AS rows ${LIVE_SOURCE_ROWS_JOIN}
           WHERE rows.entity_kind = 'link' AND rows.source_type_id = ?
           ORDER BY 1`
        )
        .all(projectId, type, projectId, type, projectId, type) as { readonly link_id: string }[]
      const series = this.db
        .query(
          `SELECT DISTINCT property_id FROM timeseries
           WHERE project_id = ? AND object_type_id = ? ORDER BY 1`
        )
        .all(projectId, type) as { readonly property_id: string }[]

      return {
        linkIds: links.map((row) => row.link_id),
        seriesPropertyIds: series.map((row) => row.property_id),
      }
    })
  }

  async listHeldPropertyKeys(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<readonly string[]> {
    return this.runRootOperation(() => {
      const { projectId, objectTypeId: type } = input
      const edits = "ontology_object_overrides AS edits"
      const ofType = (alias: string) => `${alias}.project_id = ? AND ${alias}.object_type_id = ?`
      const rows = this.db
        .query(
          `SELECT keys.key FROM objects AS o, json_each(o.properties) AS keys WHERE ${ofType("o")}
           UNION
           SELECT keys.key FROM ${edits}, json_each(edits.value, '$.properties') AS keys
           WHERE ${ofType("edits")}
           UNION
           SELECT keys.key FROM ${edits}, json_each(edits.value, '$.set') AS keys
           WHERE ${ofType("edits")}
           UNION
           SELECT keys.value FROM ${edits}, json_each(edits.value, '$.unset') AS keys
           WHERE ${ofType("edits")}
           UNION
           SELECT keys.key FROM ${edits}, json_each(edits.edited_at) AS keys
           WHERE ${ofType("edits")} AND json_type(edits.edited_at) = 'object'
           UNION
           SELECT property_id FROM timeseries AS t WHERE ${ofType("t")}
           ORDER BY 1`
        )
        .all(...Array.from({ length: 6 }, () => [projectId, type]).flat()) as {
        readonly key: string
      }[]
      return rows.map((row) => row.key)
    })
  }

  async listEdits(input: ListObjectEditsInput): Promise<{
    readonly edits: readonly StoredObjectEdit[]
    readonly nextPrimaryId?: string
  }> {
    return this.runRootOperation(() => {
      const filters: string[] = []
      const params: SQLQueryBindings[] = [input.projectId, input.objectTypeId]

      if (input.withValueOf !== undefined) {
        const path = keyPath(input.withValueOf)
        filters.push(
          "AND (json_type(value, '$.properties' || ?) IS NOT NULL OR json_type(value, '$.set' || ?) IS NOT NULL)"
        )
        params.push(path, path)
      }
      if (input.afterPrimaryId !== undefined) {
        filters.push("AND primary_id > ?")
        params.push(input.afterPrimaryId)
      }

      const rows = this.db
        .query(
          `SELECT primary_id, value, edited_at FROM ontology_object_overrides
           WHERE project_id = ? AND object_type_id = ?
             AND json_extract(value, '$.kind') IN ('create', 'patch')
             ${filters.join(" ")}
           ORDER BY primary_id
           LIMIT ?`
        )
        .all(...params, input.limit + 1) as {
        readonly primary_id: string
        readonly value: string
        readonly edited_at: string
      }[]

      const edits = rows.slice(0, input.limit).map((row) => ({
        primaryId: row.primary_id,
        value: JSON.parse(row.value),
        editedAt: JSON.parse(row.edited_at),
      }))
      if (rows.length <= input.limit) return { edits }

      return { edits, nextPrimaryId: edits.at(-1)!.primaryId }
    })
  }
}

/** One query per store the probe reads, as in PostgreSQL: see `PgOntologyTypeShapeStorage`. */
function probeHolders(input: TypeShapeProbeInput): Holder[] {
  const { projectId, objectTypeId: type, probe } = input

  switch (probe.kind) {
    case "property": {
      const key = probe.propertyId
      const path = keyPath(key)
      return [
        {
          sql: `SELECT primary_id FROM objects
                WHERE project_id = ? AND object_type_id = ? AND json_type(properties, '$' || ?) IS NOT NULL`,
          params: [projectId, type, path],
        },
        {
          // `json_each` has a `value` column of its own: the edit's is named by its alias.
          sql: `SELECT edits.primary_id FROM ontology_object_overrides AS edits
                WHERE edits.project_id = ? AND edits.object_type_id = ?
                  AND (json_type(edits.value, '$.properties' || ?) IS NOT NULL
                    OR json_type(edits.value, '$.set' || ?) IS NOT NULL
                    OR EXISTS (
                      SELECT 1 FROM json_each(edits.value, '$.unset') AS unset
                      WHERE unset.value = ?
                    )
                    OR json_type(edits.edited_at, '$' || ?) IS NOT NULL)`,
          params: [projectId, type, path, path, key, path],
        },
        {
          sql: `SELECT rows.primary_id FROM ontology_source_rows AS rows ${LIVE_SOURCE_ROWS_JOIN}
                WHERE rows.entity_kind = 'object' AND rows.object_type_id = ?
                  AND (json_type(rows.payload, '$.properties' || ?) IS NOT NULL
                    OR EXISTS (
                      SELECT 1 FROM json_each(rows.payload, '$.absentSourcePropertyIds') AS absent
                      WHERE absent.value = ?
                    ))`,
          params: [projectId, type, path, key],
        },
        {
          sql: `SELECT object_id FROM timeseries
                WHERE project_id = ? AND object_type_id = ? AND property_id = ?`,
          params: [projectId, type, key],
        },
      ]
    }

    case "missingRequired":
      return [
        // An object created by an edit has no live source row: its root key is its own.
        {
          sql: `SELECT edits.primary_id FROM ontology_object_overrides AS edits
                WHERE edits.project_id = ? AND edits.object_type_id = ?
                  AND json_extract(edits.value, '$.kind') = 'create'
                  AND json_type(edits.value, '$.properties' || ?) IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM ontology_source_roots AS roots
                    JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
                      AND versions.status IN ${PUBLISHED}
                    WHERE roots.project_id = ? AND roots.retired_at IS NULL AND roots.deleted = 0
                      AND roots.root_key = json_array('object', edits.object_type_id, edits.primary_id)
                  )`,
          params: [projectId, type, keyPath(probe.propertyId), projectId],
        },
        // An edit that cleared the value, on any object: it wins unless a newer source does.
        {
          sql: `SELECT edits.primary_id FROM ontology_object_overrides AS edits
                WHERE edits.project_id = ? AND edits.object_type_id = ?
                  AND json_extract(edits.value, '$.kind') = 'patch'
                  AND EXISTS (
                    SELECT 1 FROM json_each(edits.value, '$.unset') AS unset
                    WHERE unset.value = ?
                  )`,
          params: [projectId, type, probe.propertyId],
        },
      ]

    case "link":
      return linkHolders(projectId, type, probe.linkId)

    case "type":
      return [
        {
          sql: "SELECT primary_id FROM objects WHERE project_id = ? AND object_type_id = ?",
          params: [projectId, type],
        },
        {
          sql: `SELECT primary_id FROM ontology_object_overrides
                WHERE project_id = ? AND object_type_id = ?`,
          params: [projectId, type],
        },
        {
          sql: `SELECT rows.primary_id FROM ontology_source_rows AS rows ${LIVE_SOURCE_ROWS_JOIN}
                WHERE rows.entity_kind = 'object' AND rows.object_type_id = ?`,
          params: [projectId, type],
        },
        {
          sql: "SELECT object_id FROM timeseries WHERE project_id = ? AND object_type_id = ?",
          params: [projectId, type],
        },
        ...linkHolders(projectId, type, undefined),
      ]
  }
}

/** Links, link edits of either identity and any kind, and live source link rows of the type. */
function linkHolders(projectId: string, type: string, linkId: string | undefined): Holder[] {
  const link = linkId === undefined ? "" : "AND link_id = ?"
  const linkParams = linkId === undefined ? [] : [linkId]

  return [
    {
      sql: `SELECT source_id FROM links WHERE project_id = ? AND source_type_id = ? ${link}`,
      params: [projectId, type, ...linkParams],
    },
    {
      sql: `SELECT source_primary_id FROM ontology_link_overrides
            WHERE project_id = ? AND identity_kind IN ('edge', 'slot') AND source_type_id = ?
              ${link}`,
      params: [projectId, type, ...linkParams],
    },
    {
      sql: `SELECT rows.source_primary_id FROM ontology_source_rows AS rows ${LIVE_SOURCE_ROWS_JOIN}
            WHERE rows.entity_kind = 'link' AND rows.source_type_id = ? ${link}`,
      params: [projectId, type, ...linkParams],
    },
  ]
}

/** The JSON path suffix of a key, quoted so any property id addresses one member: `."gate"`. */
function keyPath(key: string): string {
  return `.${JSON.stringify(key)}`
}
