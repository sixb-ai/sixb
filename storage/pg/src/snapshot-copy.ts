import type { SnapshotCopyCounts, SnapshotCopyPlan, SnapshotCopyType } from "@sixb/core/storage"
import { quoteIdent } from "./migrations"
import { objectPartitionName } from "./objects/partitions"
import { literal } from "./objects/sql-text"
import type { ReservedSQL, SQLClient } from "./pg-client"
import {
  assertEmpty,
  type BranchSchemaState,
  dropSecondaryIndexes,
  LOADED_TABLES,
  markState,
  writeCommit,
} from "./snapshot-load"
import { runPgTransactionOn } from "./transactions"

// A snapshot copied inside PostgreSQL, for a reader that sees every object and property of what it
// reads: the rows never leave the server. It writes what a load of the same snapshot writes, row
// for row; times are cut to the millisecond, as the snapshot's format carries them.

/**
 * Lanes a copy takes. Each row the lanes insert is logged, and the log is one stream: past a few
 * lanes they wait on it rather than copy (1M objects: 22 s on 3 lanes, 25 s on 6, 30 s on 10).
 */
export const COPY_LANES = 4

/** A type this large is copied in ranges of primary ids, side by side. */
const RANGE_MIN_OBJECTS = 200_000

/** `YYYY-MM-DDTHH:MM:SS.mmmZ`, as JavaScript writes a time. */
const ISO = (column: string) =>
  `to_char(date_trunc('milliseconds', ${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const MS = (column: string) => `date_trunc('milliseconds', ${column})`

interface Range {
  readonly after?: string
  readonly through?: string
}

interface TypeCounts {
  objects: number
  links: number
  droppedLinks: number
  points: number
  vectors: Map<string, number>
}

interface CopyWork {
  readonly label: string
  run(sql: ReservedSQL): Promise<void>
}

/**
 * Copy from the `source` schema into this connection's schema, as `plan` says, at the snapshot
 * `snapshotId` exported by a transaction of the source that stays open until every lane adopted it.
 *
 * 1. One transaction writes the commit, marks the schema `loading`, and drops the keys and
 *    indexes of the tables the copy fills.
 * 2. Lanes, each a transaction on the snapshot, take work by type and range of primary ids until
 *    none is left, then commit.
 * 3. Each table is analyzed, its keys and indexes are built again side by side, and the mark is
 *    cleared. Vacuuming is left to autovacuum: at 10M objects it rewrote every page for 90 s, and
 *    counts on the branch were no faster for it.
 *
 * A failure rolls back the open lanes, empties what any committed and adds the keys and indexes
 * again. A crash leaves the mark.
 */
export async function copySnapshotInPg(input: {
  readonly connections: readonly ReservedSQL[]
  readonly sourceSchema: string
  readonly snapshotId: string
  readonly projectId: string
  readonly plan: SnapshotCopyPlan
  readonly bounds: ReadonlyMap<string, readonly string[]>
  readonly state: BranchSchemaState
  /** Runs once every lane holds the snapshot: the source's transaction may end then. */
  readonly adopted: () => Promise<void>
}): Promise<SnapshotCopyCounts> {
  const { connections, plan, projectId, state } = input
  const first = connections[0]!
  const source = quoteIdent(input.sourceSchema)

  const { indexes, keys } = await runPgTransactionOn(first, async () => {
    await assertEmpty(first)
    await writeCommit(first, {
      projectId,
      commit: plan.commit,
      uniqueProperties: plan.uniqueProperties,
    })
    await markState(first, { ...state, loading: true })

    return {
      keys: await dropKeys(first, LOADED_TABLES),
      indexes: await dropSecondaryIndexes(first, LOADED_TABLES),
    }
  })

  const counts = new Map<string, TypeCounts>(
    plan.types.map((type) => [
      type.objectTypeId,
      { objects: 0, links: 0, droppedLinks: 0, points: 0, vectors: new Map() },
    ])
  )
  let users = 0
  const context = { source, projectId, commitId: plan.commit.id, counts }
  const work: CopyWork[] = [
    ...plan.types.flatMap((type) =>
      ranges(input.bounds.get(type.objectTypeId) ?? []).flatMap((range) =>
        typeWork(context, type, range)
      )
    ),
    {
      label: "members",
      run: async (sql) => {
        users = await copyMembers(sql, source, projectId, plan.members)
      },
    },
  ]
  // The largest pieces first, so the last lane to finish has a short one.
  work.sort((left, right) => weight(right) - weight(left))

  const open: ReservedSQL[] = []
  // What the finish added again already, which a failure after it must not add twice.
  const added = new Set<string>()
  try {
    for (const sql of connections) {
      await sql.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ")
      open.push(sql)
      await sql.unsafe(`SET TRANSACTION SNAPSHOT '${input.snapshotId.replace(/'/g, "''")}'`)
      await sql.unsafe("SET LOCAL statement_timeout = 0")
    }
    await input.adopted()

    await Promise.all(
      connections.map(async (sql) => {
        for (let next = work.shift(); next; next = work.shift()) await next.run(sql)
      })
    )
    for (const sql of [...open]) {
      await sql.unsafe("COMMIT")
      open.splice(open.indexOf(sql), 1)
    }

    await finish(connections, keys, indexes, added)
    await markState(first, state)
  } catch (error) {
    work.length = 0
    for (const sql of open) await sql.unsafe("ROLLBACK").catch(() => undefined)
    await runPgTransactionOn(first, async () => {
      await first.unsafe(`TRUNCATE ${LOADED_TABLES.join(", ")}`)
      await first`DELETE FROM object_unique_properties WHERE project_id = ${projectId}`
      await first`DELETE FROM ontology_commits WHERE project_id = ${projectId} AND id = ${plan.commit.id}`
      for (const definition of [...keys.tables, ...keys.partitioned, ...indexes, ...keys.foreign]) {
        if (!added.has(definition)) await first.unsafe(definition)
      }
      await markState(first, state)
    })
    throw error
  }

  return { types: counts, users }
}

/** How to add again the keys a copy dropped, in the order they can be. */
interface DroppedKeys {
  /** Primary and unique keys of plain tables and of partitions, each built on its own. */
  readonly tables: readonly string[]
  /** A partitioned table's, which attaches its partitions' keys once they exist. */
  readonly partitioned: readonly string[]
  /** Foreign keys, which read the keys they reference. */
  readonly foreign: readonly string[]
}

/**
 * Drop the keys of the tables the copy fills until it ends. Lanes inserting side by side into one
 * B-tree contend for its pages, and log every insert: a key built afterwards is one sorted pass.
 * Foreign keys go too: the lanes read at production's snapshot, which predates the commit the
 * rows name. Added again, each key checks every copied row.
 */
async function dropKeys(sql: SQLClient, tables: readonly string[]): Promise<DroppedKeys> {
  const keys = await sql<
    { table: string; name: string; definition: string; kind: string; partitioned: boolean }[]
  >`
    SELECT owner.relname AS table, constraint_row.conname AS name,
      pg_get_constraintdef(constraint_row.oid) AS definition, constraint_row.contype AS kind,
      owner.relkind = 'p' AS partitioned
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS owner ON owner.oid = constraint_row.conrelid
    WHERE owner.relnamespace = current_schema()::regnamespace
      AND constraint_row.contype IN ('p', 'u', 'f')
      AND (constraint_row.contype <> 'f' OR constraint_row.conparentid = 0)
      AND (owner.relname = ANY(${tables}::text[]) OR EXISTS (
        SELECT 1 FROM pg_inherits AS link JOIN pg_class AS parent ON parent.oid = link.inhparent
        WHERE link.inhrelid = owner.oid AND parent.relname = ANY(${tables}::text[])
      ))
    ORDER BY constraint_row.contype = 'f' DESC, constraint_row.conparentid = 0 DESC
  `
  const add = (key: (typeof keys)[number]) =>
    `ALTER TABLE ${quoteIdent(key.table)} ADD CONSTRAINT ${quoteIdent(key.name)} ${key.definition}`

  // Foreign keys first, then a partitioned table's key, which takes its partitions' with it.
  for (const key of keys) {
    const inherited = key.kind !== "f" && !key.partitioned && (await isPartition(sql, key.table))
    if (inherited) continue
    await sql.unsafe(`ALTER TABLE ${quoteIdent(key.table)} DROP CONSTRAINT ${quoteIdent(key.name)}`)
  }

  return {
    tables: keys.filter((key) => key.kind !== "f" && !key.partitioned).map(add),
    partitioned: keys.filter((key) => key.kind !== "f" && key.partitioned).map(add),
    foreign: keys.filter((key) => key.kind === "f").map(add),
  }
}

async function isPartition(sql: SQLClient, table: string): Promise<boolean> {
  const [row] = await sql<{ partition: boolean }[]>`
    SELECT relispartition AS partition FROM pg_class
    WHERE relnamespace = current_schema()::regnamespace AND relname = ${table}
  `
  return row?.partition === true
}

/**
 * Analyze every table, then build the keys and indexes side by side: partitions' keys before their
 * table's, which attaches them, and foreign keys last.
 */
async function finish(
  connections: readonly ReservedSQL[],
  keys: DroppedKeys,
  indexes: readonly string[],
  added: Set<string>
) {
  const tables = [...LOADED_TABLES]
  await Promise.all(
    connections.map(async (sql) => {
      for (let table = tables.shift(); table; table = tables.shift()) {
        await sql.unsafe(`ANALYZE ${table}`)
      }
    })
  )

  await sideBySide(connections, keys.tables, added)
  await sideBySide(connections.slice(0, 1), keys.partitioned, added)
  await sideBySide(connections, indexes, added)
  await sideBySide(connections.slice(0, 1), keys.foreign, added)
}

/** Run `statements` across the connections, each taking the next as it ends one. */
async function sideBySide(
  connections: readonly ReservedSQL[],
  statements: readonly string[],
  added: Set<string>
) {
  const pending = [...statements]
  await Promise.all(
    connections.map(async (sql) => {
      await sql.unsafe("SET maintenance_work_mem = '256MB'")
      for (let statement = pending.shift(); statement; statement = pending.shift()) {
        await sql.unsafe(statement)
        added.add(statement)
      }
      await sql.unsafe("RESET maintenance_work_mem")
    })
  )
}

function ranges(bounds: readonly string[]): Range[] {
  if (bounds.length === 0) return [{}]
  return [
    { through: bounds[0]! },
    ...bounds.slice(1).map((through, index) => ({ after: bounds[index]!, through })),
    { after: bounds.at(-1)! },
  ]
}

function weight(work: CopyWork): number {
  return work.label.startsWith("objects") || work.label.startsWith("overrides") ? 2 : 1
}

interface CopyContext {
  readonly source: string
  readonly projectId: string
  readonly commitId: string
  readonly counts: Map<string, TypeCounts>
}

/** `column` within `range`, its bounds written as literals: a statement takes no unused one. */
function within(column: string, range: Range): string {
  return [
    range.after === undefined ? "" : ` AND ${column} > ${literal(range.after)}`,
    range.through === undefined ? "" : ` AND ${column} <= ${literal(range.through)}`,
  ].join("")
}

/** The rows of one type, or of one range of its primary ids, table by table. */
function typeWork(context: CopyContext, type: SnapshotCopyType, range: Range): CopyWork[] {
  const { source, projectId, commitId } = context
  const counts = context.counts.get(type.objectTypeId)!
  const objectTypeId = type.objectTypeId
  const objectsOf = `FROM ${source}.objects WHERE project_id = $1 AND object_type_id = $2${within("primary_id", range)}`

  const work: CopyWork[] = [
    {
      label: `objects ${objectTypeId}`,
      run: async (sql) => {
        const inserted = await sql.unsafe(
          `INSERT INTO ${quoteIdent(objectPartitionName(objectTypeId))}
             (project_id, object_type_id, primary_id, properties, created_at, updated_at, version, last_commit_id)
           SELECT project_id, object_type_id, primary_id, properties - $3::text[],
             ${MS("created_at")}, ${MS("updated_at")}, 1, $4 ${objectsOf}`,
          [projectId, objectTypeId, [...type.droppedPropertyIds], commitId] as never[]
        )
        counts.objects += inserted.count
        await copyVectors(sql, context, type, range)
      },
    },
    {
      label: `overrides ${objectTypeId}`,
      run: async (sql) => {
        // Every property was edited when the object last changed: its time, written once a row.
        await sql.unsafe(
          `INSERT INTO ontology_object_overrides
             (project_id, object_type_id, primary_id, value, last_commit_id, updated_at, edited_at)
           SELECT project_id, object_type_id, primary_id,
             jsonb_build_object('kind', 'create', 'properties', edited.properties), $4,
             ${MS("updated_at")},
             COALESCE(
               (SELECT jsonb_object_agg(key, edited.at)
                FROM jsonb_object_keys(edited.properties) AS key),
               '{}'::jsonb
             )
           FROM ${source}.objects AS object
           CROSS JOIN LATERAL (
             SELECT object.properties - $3::text[] AS properties, to_jsonb(${ISO("object.updated_at")}) AS at
           ) AS edited
           WHERE project_id = $1 AND object_type_id = $2${within("primary_id", range)}`,
          [
            projectId,
            objectTypeId,
            [...type.droppedPropertyIds, ...type.telemetryPropertyIds],
            commitId,
          ] as never[]
        )
      },
    },
    {
      label: `derived ${objectTypeId}`,
      run: async (sql) => {
        for (const [table, columns, propertyIds] of [
          [
            "object_unique_values",
            "project_id, object_type_id, property_id, value_hash, value_key, primary_id",
            type.uniquePropertyIds,
          ],
          [
            "object_artifact_refs",
            "project_id, artifact_id, object_type_id, primary_id, property_id",
            type.artifactPropertyIds,
          ],
        ] as const) {
          if (propertyIds.length === 0) continue
          await sql.unsafe(
            `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${source}.${table}
             WHERE project_id = $1 AND object_type_id = $2 AND property_id = ANY($3::text[])${within("primary_id", range)}`,
            [projectId, objectTypeId, [...propertyIds]] as never[]
          )
        }
      },
    },
  ]

  if (type.links.length > 0) work.push(...linkWork(context, type, range))
  if (type.telemetryPropertyIds.length > 0) work.push(pointWork(context, type, range))
  return work
}

/** The kept links, as the edge's or the slot's edit, and how many the branch does not keep. */
function linkWork(context: CopyContext, type: SnapshotCopyType, range: Range): CopyWork[] {
  const { source, projectId, commitId } = context
  const counts = context.counts.get(type.objectTypeId)!
  const args = [
    projectId,
    type.objectTypeId,
    type.links.map((link) => link.linkId),
    type.links.map((link) => link.targetTypeId),
    type.links.map((link) => link.identity),
    commitId,
  ]
  const kept = `FROM ${source}.links AS link
    JOIN unnest($3::text[], $4::text[], $5::text[]) AS kept(link_id, target_type_id, identity)
      ON kept.link_id = link.link_id AND kept.target_type_id = link.target_type_id
    WHERE link.project_id = $1 AND link.source_type_id = $2${within("link.source_id", range)}`

  return [
    {
      label: `links ${type.objectTypeId}`,
      run: async (sql) => {
        const inserted = await sql.unsafe(
          `INSERT INTO links (project_id, source_type_id, source_id, link_id, target_type_id,
             target_id, properties, created_at, updated_at, last_commit_id)
           SELECT link.project_id, link.source_type_id, link.source_id, link.link_id,
             link.target_type_id, link.target_id, link.properties, ${MS("link.created_at")},
             ${MS("link.updated_at")}, $6 ${kept}`,
          args as never[]
        )
        const [all] = await sql.unsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM ${source}.links AS link
           WHERE link.project_id = $1 AND link.source_type_id = $2${within("link.source_id", range)}`,
          [projectId, type.objectTypeId] as never[]
        )
        counts.links += inserted.count
        counts.droppedLinks += (all?.count ?? 0) - inserted.count
      },
    },
    {
      label: `link overrides ${type.objectTypeId}`,
      run: async (sql) => {
        await sql.unsafe(
          `INSERT INTO ontology_link_overrides (project_id, identity_kind, identity_key,
             source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, value,
             last_commit_id, updated_at)
           SELECT link.project_id, kept.identity,
             CASE kept.identity
               WHEN 'slot' THEN jsonb_build_array(link.source_type_id, link.source_id, link.link_id)
               ELSE jsonb_build_array(link.source_type_id, link.source_id, link.link_id,
                 link.target_type_id, link.target_id)
             END,
             link.source_type_id, link.source_id, link.link_id, link.target_type_id, link.target_id,
             CASE kept.identity
               WHEN 'slot' THEN jsonb_build_object('kind', 'set', 'target',
                 jsonb_build_object('objectTypeId', link.target_type_id, 'primaryId', link.target_id))
               ELSE jsonb_build_object('kind', 'upsert')
             END || CASE WHEN link.properties IS NULL THEN '{}'::jsonb
               ELSE jsonb_build_object('properties', link.properties) END,
             $6, ${MS("link.updated_at")} ${kept}`,
          args as never[]
        )
      },
    },
  ]
}

/** The latest point of each series of an object that holds it, as history and as latest. */
function pointWork(context: CopyContext, type: SnapshotCopyType, range: Range): CopyWork {
  const { source, projectId, commitId } = context
  const counts = context.counts.get(type.objectTypeId)!

  return {
    label: `points ${type.objectTypeId}`,
    run: async (sql) => {
      const args = [projectId, type.objectTypeId, [...type.telemetryPropertyIds], commitId]
      const select = `SELECT point.project_id, point.object_type_id, point.object_id,
          point.property_id, point.value, point.unit, ${MS("point.at")}, $4
        FROM ${source}.timeseries_latest AS point
        WHERE point.project_id = $1 AND point.object_type_id = $2
          AND point.property_id = ANY($3::text[])${within("point.object_id", range)}
          AND EXISTS (
            SELECT 1 FROM ${source}.objects AS object
            WHERE object.project_id = point.project_id
              AND object.object_type_id = point.object_type_id
              AND object.primary_id = point.object_id
              AND object.properties ? point.property_id
          )`
      const columns =
        "(project_id, object_type_id, object_id, property_id, value, unit, at, last_commit_id)"
      const inserted = await sql.unsafe(
        `INSERT INTO timeseries ${columns} ${select}`,
        args as never[]
      )
      await sql.unsafe(`INSERT INTO timeseries_latest ${columns} ${select}`, args as never[])
      counts.points += inserted.count
    },
  }
}

/**
 * The vectors still computed from what their object holds: the source fingerprint is computed
 * here as JavaScript computes it, the SHA-256 of the JSON string of `[[source, value], …]`.
 */
async function copyVectors(
  sql: SQLClient,
  context: CopyContext,
  type: SnapshotCopyType,
  range: Range
): Promise<void> {
  const counts = context.counts.get(type.objectTypeId)!

  for (const vector of type.vectors) {
    const first = 7
    const pairs = vector.source
      .map((_, index) => {
        const key = `$${index + first}::text`
        return `'[' || to_json(${key})::text || ',' || COALESCE(to_json(object.properties ->> ${key})::text, 'null') || ']'`
      })
      .join(" || ',' || ")
    const fingerprint = `encode(sha256(convert_to(to_json('[' || ${pairs} || ']')::text, 'UTF8')), 'hex')`
    const select = `FROM ${context.source}.object_vectors AS vector
      JOIN ${context.source}.objects AS object USING (project_id, object_type_id, primary_id)
      WHERE vector.project_id = $1 AND vector.object_type_id = $2 AND vector.profile = $3
        AND vector.configuration = $4 AND array_length(vector.embedding, 1) = $5
        ${within("vector.primary_id", range)}
        AND vector.source_fingerprint = ${fingerprint}`
    const args = [
      context.projectId,
      type.objectTypeId,
      vector.profile,
      vector.configuration,
      vector.dimensions,
      context.commitId,
      ...vector.source,
    ]

    const result = vector.copy
      ? await sql.unsafe(
          `INSERT INTO object_vectors (project_id, object_type_id, primary_id, profile,
             configuration, source, source_fingerprint, embedding, last_commit_id)
           SELECT vector.project_id, vector.object_type_id, vector.primary_id, vector.profile,
             vector.configuration, vector.source, vector.source_fingerprint, vector.embedding, $6
           ${select}`,
          args as never[]
        )
      : await sql.unsafe(`SELECT $6::text AS commit ${select}`, args as never[])

    counts.vectors.set(vector.profile, (counts.vectors.get(vector.profile) ?? 0) + result.count)
  }
}

/** Members, as a load writes them: kept when there already, suspended by hand when suspended. */
async function copyMembers(
  sql: SQLClient,
  source: string,
  projectId: string,
  members: SnapshotCopyPlan["members"]
): Promise<number> {
  const all = members === "all"
  const ids = all ? [] : [...members]

  const users = await sql.unsafe(
    `INSERT INTO auth_users (project_id, id, email, display_name, avatar_url, status,
       suspension_source, created_at, updated_at)
     SELECT project_id, id, email, display_name, avatar_url, status,
       CASE WHEN status = 'suspended' THEN 'manual' END, ${MS("created_at")}, ${MS("updated_at")}
     FROM ${source}.auth_users
     WHERE project_id = $1 AND ($2 OR id = ANY($3::text[]))
     ON CONFLICT DO NOTHING`,
    [projectId, all, ids] as never[]
  )
  await sql.unsafe(
    `INSERT INTO auth_group_memberships (project_id, user_id, group_id, source, created_at)
     SELECT project_id, user_id, group_id, source, ${MS("created_at")}
     FROM ${source}.auth_group_memberships
     WHERE project_id = $1 AND ($2 OR user_id = ANY($3::text[]))
     ON CONFLICT DO NOTHING`,
    [projectId, all, ids] as never[]
  )
  return users.count
}

/** Where to cut each large type: existing ids in the snapshot, from the partition's statistics. */
export async function copyBounds(
  sql: SQLClient,
  sourceSchema: string,
  projectId: string,
  types: readonly SnapshotCopyType[],
  parts: number
): Promise<Map<string, readonly string[]>> {
  const bounds = new Map<string, readonly string[]>()

  for (const type of types) {
    const partition = objectPartitionName(type.objectTypeId)
    const [stats] = await sql<{ rows: number; bounds: string[] | null }[]>`
      SELECT class.reltuples::float8 AS rows,
        (SELECT histogram_bounds::text::text[] FROM pg_stats
          WHERE schemaname = ${sourceSchema} AND tablename = ${partition}
            AND attname = 'primary_id') AS bounds
      FROM pg_class AS class
      WHERE class.oid = to_regclass(${`${quoteIdent(sourceSchema)}.${quoteIdent(partition)}`})
    `
    const histogram = stats?.bounds ?? []
    if (!stats || stats.rows < RANGE_MIN_OBJECTS || histogram.length < parts) continue

    const cuts: string[] = []
    for (let part = 1; part < parts; part += 1) {
      const bound = histogram[Math.floor((part * histogram.length) / parts)]!
      const [row] = await sql.unsafe<{ primary_id: string }[]>(
        `SELECT primary_id FROM ${quoteIdent(sourceSchema)}.objects
         WHERE project_id = $1 AND object_type_id = $2 AND primary_id >= $3
         ORDER BY primary_id LIMIT 1`,
        [projectId, type.objectTypeId, bound] as never[]
      )
      if (row && row.primary_id !== cuts.at(-1)) cuts.push(row.primary_id)
    }
    bounds.set(type.objectTypeId, cuts)
  }

  return bounds
}
