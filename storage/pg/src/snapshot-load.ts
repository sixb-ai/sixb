import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  sourceAssertionPayload,
  sourceEntityColumns,
} from "@sixb/core/internal/ontology-storage-provider"
import { snapshotEditedAt, snapshotTargetNotEmpty } from "@sixb/core/internal/storage"
import type {
  SnapshotLoadBatch,
  SnapshotLoadInput,
  SnapshotObjectWrite,
  SnapshotSourceRootWrite,
  SnapshotTypeEdits,
  StoredObjectVector,
} from "@sixb/core/storage"
import { objectPartitionName } from "./objects/partitions"
import { insertPgRuntimeCommit } from "./ontology-storage/commits"
import type { ReservedSQL, SQLClient } from "./pg-client"
import { runPgTransactionOn } from "./transactions"

const COPY_BATCH_BYTES = 8 * 1024 * 1024

/**
 * Tables loaded together, each group on a connection and in a transaction of its own, so they
 * load and index in parallel. A vector's foreign key reads its object, so they share one.
 */
const LANES = [
  ["objects", "object_vectors"],
  ["ontology_object_overrides"],
  ["links"],
  ["ontology_link_overrides"],
  ["timeseries", "timeseries_latest"],
  ["object_unique_values", "object_artifact_refs"],
  // A replacement plan references a source version: the four truncate together.
  [
    "ontology_replacement_plans",
    "ontology_sources",
    "ontology_source_roots",
    "ontology_source_rows",
  ],
] as const

export const SNAPSHOT_LANES = LANES.length

const LOADED_TABLES: readonly string[] = LANES.flat()

/** What one lane's index builds may take: six lanes stay within a small instance's memory. */
const LANE_MAINTENANCE_WORK_MEM = "256MB"
const LANE_MAINTENANCE_WORKERS = 2

/**
 * How often a lane with nothing to do sends a statement, so that it never sits idle in its
 * transaction long enough for the server, or a hosted branch's production, to end it: a lane
 * waits for the others to copy and index, minutes at volume.
 */
const LANE_HEARTBEAT_MS = 20_000

/** A branch schema's state, kept in its comment, so a load cut short is never taken as done. */
export interface BranchSchemaState {
  readonly sixbBranch: string
  readonly loading?: true
}

interface Lane {
  readonly connection: ReservedSQL
  readonly tables: readonly string[]
  /** The indexes this lane dropped, to build again before it commits. */
  indexes: readonly string[]
  /** The lane's statements, one after another: each waits for the one before (`onLane`). */
  tail: Promise<void>
  /** Its statements queued and not done. With none, the lane waits inside its transaction. */
  queued: number
}

/** Rows waiting for one `COPY`: text lines, or rows in binary COPY format. */
interface Pending {
  readonly chunks: (string | Uint8Array)[]
  readonly binary: boolean
  bytes: number
}

/**
 * Writes a snapshot into an empty branch schema.
 *
 * 1. One transaction writes the commit and marks the schema as loading.
 * 2. Each lane, in a transaction of its own, truncates its tables, which are empty, so that
 *    `COPY … FREEZE` writes rows already visible to all, drops its tables' secondary indexes,
 *    copies its rows, builds the indexes again in one pass and runs `ANALYZE`.
 * 3. The lanes commit in turn; the last one clears the mark.
 *
 * A failure rolls back the lanes still open and empties what any committed; a crash between two
 * commits leaves the mark, and the namespace refuses to open until it is dropped.
 */
export class PgSnapshotLoad {
  readonly #input: SnapshotLoadInput
  readonly #lanes: readonly Lane[]
  readonly #pending = new Map<string, Pending>()
  /** Each source taken over, by projection: its version id, and how many roots it holds. */
  readonly #sources = new Map<string, { readonly versionId: string; roots: number }>()

  private constructor(input: SnapshotLoadInput, lanes: readonly Lane[]) {
    this.#input = input
    this.#lanes = lanes
  }

  /**
   * Load with `run`, on `connections` (one per lane at most) the caller reserved from the
   * branch schema's pool and holds the schema's load lock on.
   */
  static async run<T>(
    connections: readonly ReservedSQL[],
    input: SnapshotLoadInput,
    state: BranchSchemaState,
    run: (load: PgSnapshotLoad) => Promise<T>
  ): Promise<T> {
    const [first] = connections
    if (!first) throw new Error("[SixbPg] A snapshot load needs a connection.")

    await runPgTransactionOn(first, async () => {
      await assertEmpty(first)
      await writeCommit(first, input)
      await markState(first, { ...state, loading: true })
    })

    const lanes: Lane[] = connections.map((connection, index) => ({
      connection,
      tables: LANES.filter((_, lane) => lane % connections.length === index).flat(),
      indexes: [],
      tail: Promise.resolve(),
      queued: 0,
    }))
    const open: Lane[] = []
    const every = await heartbeatMillis(first)
    const beat = setInterval(() => keepAlive(open), every)

    try {
      for (const lane of lanes) {
        await lane.connection.unsafe("BEGIN")
        open.push(lane)
        await onLane(lane, () => openLane(lane))
      }

      const load = new PgSnapshotLoad(input, lanes)
      const result = await run(load)
      await load.#finish(open, state)
      return result
    } catch (error) {
      clearInterval(beat)
      for (const lane of open.splice(0)) {
        await lane.tail.catch(() => undefined)
        await lane.connection.unsafe("ROLLBACK").catch(() => undefined)
      }
      await emptyAgain(first, input, state)
      throw error
    } finally {
      // Nothing in flight once the caller releases the connections.
      clearInterval(beat)
      await Promise.all(lanes.map((lane) => lane.tail.catch(() => undefined)))
    }
  }

  async write(batch: SnapshotLoadBatch): Promise<void> {
    const projectId = this.#input.projectId
    const commitId = this.#input.commit.id
    const objects = batch.objects ?? []
    const links = batch.links ?? []
    const points = batch.points ?? []

    for (const source of batch.sources ?? []) await this.#writeSource(source)
    if (batch.sourceRoots?.length) await this.#writeSourceRoots(batch.sourceRoots)
    if (batch.edits) await this.#writeEdits(batch.edits)

    // Into each type's own partition: COPY FREEZE does not reach a partitioned table.
    for (const [objectTypeId, rows] of byType(objects)) {
      await this.#copy(
        `${objectPartitionName(objectTypeId)} (project_id, object_type_id, primary_id, properties, created_at, updated_at, version, last_commit_id)`,
        rows.map((row) => [
          projectId,
          row.objectTypeId,
          row.primaryId,
          JSON.stringify(row.properties),
          row.createdAt,
          row.updatedAt,
          "1",
          commitId,
        ])
      )
    }
    await this.#copy(
      OBJECT_OVERRIDE_COLUMNS,
      objects.flatMap((row) =>
        row.override
          ? [
              [
                projectId,
                row.objectTypeId,
                row.primaryId,
                JSON.stringify(row.override),
                commitId,
                row.updatedAt,
                JSON.stringify(snapshotEditedAt(row.override.properties, row.updatedAt)),
              ],
            ]
          : []
      )
    )

    await this.#copy(
      "links (project_id, source_type_id, source_id, link_id, target_type_id, target_id, properties, created_at, updated_at, last_commit_id)",
      links.map((row) => [
        projectId,
        row.sourceTypeId,
        row.sourceId,
        row.linkId,
        row.targetTypeId,
        row.targetId,
        row.properties === undefined ? null : JSON.stringify(row.properties),
        row.createdAt,
        row.updatedAt,
        commitId,
      ])
    )
    await this.#copy(
      LINK_OVERRIDE_COLUMNS,
      // A link its source asserts is its source's: no edit creates it.
      links
        .filter((row) => row.identity !== "source")
        .map((row) => {
          const slot = row.identity === "slot"
          const target = { objectTypeId: row.targetTypeId, primaryId: row.targetId }
          const extra = row.properties === undefined ? {} : { properties: row.properties }
          return [
            projectId,
            row.identity,
            JSON.stringify(
              slot
                ? [row.sourceTypeId, row.sourceId, row.linkId]
                : [row.sourceTypeId, row.sourceId, row.linkId, row.targetTypeId, row.targetId]
            ),
            row.sourceTypeId,
            row.sourceId,
            row.linkId,
            row.targetTypeId,
            row.targetId,
            JSON.stringify(slot ? { kind: "set", target, ...extra } : { kind: "upsert", ...extra }),
            commitId,
            row.updatedAt,
          ]
        })
    )

    // The latest point is the whole of each series a snapshot carries: history and latest agree.
    const pointRows = points.map((row) => [
      projectId,
      row.objectTypeId,
      row.objectId,
      row.propertyId,
      JSON.stringify(row.value),
      row.unit ?? null,
      row.at,
      commitId,
    ])
    const pointColumns =
      "(project_id, object_type_id, object_id, property_id, value, unit, at, last_commit_id)"
    await this.#copy(`timeseries ${pointColumns}`, pointRows)
    await this.#copy(`timeseries_latest ${pointColumns}`, pointRows)

    await this.#copy(
      "object_unique_values (project_id, object_type_id, property_id, value_hash, value_key, primary_id)",
      (batch.uniqueValues ?? []).map((row) => [
        projectId,
        row.objectTypeId,
        row.propertyId,
        `\\x${createHash("sha256").update(row.valueKey, "utf8").digest("hex")}`,
        row.valueKey,
        row.primaryId,
      ])
    )
    await this.#copy(
      "object_artifact_refs (project_id, artifact_id, object_type_id, primary_id, property_id)",
      (batch.artifactHolders ?? []).map((row) => [
        projectId,
        row.artifactId,
        row.objectTypeId,
        row.primaryId,
        row.propertyId,
      ])
    )
    await this.#queue(
      VECTOR_COLUMNS,
      (batch.vectors ?? []).map((row) => encodeVectorRow(projectId, row, commitId)),
      true
    )
  }

  /**
   * A source taken over: its version, active as of the base commit, inserted at once on its lane,
   * since its roots name its id. It counts its roots and assertions once they are in.
   */
  async #writeSource(source: NonNullable<SnapshotLoadBatch["sources"]>[number]): Promise<void> {
    const { commit, projectId } = this.#input
    const lane = this.#laneOf("ontology_sources")

    const [row] = await onLane(
      lane,
      (sql) => sql<{ version_id: string }[]>`
      INSERT INTO ontology_sources (
        project_id, source_id, materialization_id, projection_run_id, projection_kind, protocol,
        status, execution_token, dataset_id, dataset_version_id, dataset_version_created_at,
        projection_revision, ownership_hash, ontology_revision, root_count, assertion_count,
        created_at, ready_at, activated_at, last_commit_id, updated_at
      ) VALUES (
        ${projectId}, ${source.projectionId}, ${source.materializationId}, ${commit.id}, 'object',
        'replacement', 'active', NULL, ${source.datasetVersion.datasetId},
        ${source.datasetVersion.versionId}, ${source.datasetVersion.createdAt},
        ${source.projectionRevision}, ${source.ownershipHash}, ${source.ontologyRevision}, 0, 0,
        ${commit.committedAt}, ${commit.committedAt}, ${commit.committedAt}, ${commit.id},
        ${commit.committedAt}
      )
      RETURNING version_id
    `
    )
    if (!row) throw new Error("[SixbPg] PostgreSQL returned no source version.")
    this.#sources.set(source.projectionId, { versionId: String(row.version_id), roots: 0 })
  }

  /** Roots with the ids their rows reference, taken from the table's own sequence. */
  async #writeSourceRoots(roots: readonly SnapshotSourceRootWrite[]): Promise<void> {
    const projectId = this.#input.projectId
    const lane = this.#laneOf("ontology_source_roots")
    const ids = await onLane(
      lane,
      (sql) => sql<{ id: string }[]>`
      SELECT nextval(pg_get_serial_sequence('ontology_source_roots', 'id'))::text AS id
      FROM generate_series(1, ${roots.length})
    `
    )

    const rootRows: (string | null)[][] = []
    const assertionRows: (string | null)[][] = []
    roots.forEach((root, index) => {
      const source = this.#sources.get(root.projectionId)
      if (!source) throw new Error(`[SixbPg] Source '${root.projectionId}' was not loaded first.`)
      source.roots += 1

      const id = ids[index]!.id
      rootRows.push([id, source.versionId, projectId, root.rootKey, String(root.stagingOrdinal)])
      for (const assertion of root.assertions) {
        const entity = sourceEntityColumns(assertion)
        const payload = sourceAssertionPayload(assertion)
        assertionRows.push([
          id,
          assertion.kind,
          entity.objectTypeId,
          entity.primaryId,
          entity.sourceTypeId,
          entity.sourcePrimaryId,
          entity.linkId,
          entity.targetTypeId,
          entity.targetPrimaryId,
          payload === null ? null : JSON.stringify(payload),
        ])
      }
    })

    await this.#copy(
      "ontology_source_roots (id, version_id, project_id, root_key, staging_ordinal)",
      rootRows
    )
    await this.#copy(
      "ontology_source_rows (root_id, entity_kind, object_type_id, primary_id, source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, payload)",
      assertionRows
    )
  }

  /** The edits over types loaded as their sources, as production stored them. */
  async #writeEdits(edits: SnapshotTypeEdits): Promise<void> {
    const { projectId } = this.#input
    const commitId = this.#input.commit.id

    await this.#copy(
      OBJECT_OVERRIDE_COLUMNS,
      edits.objects.map((edit) => [
        projectId,
        edit.ref.objectTypeId,
        edit.ref.primaryId,
        JSON.stringify(edit.value),
        commitId,
        edit.updatedAt,
        JSON.stringify(edit.editedAt ?? {}),
      ])
    )
    await this.#copy(LINK_OVERRIDE_COLUMNS, [
      ...edits.links.map((edit) => {
        const { source, linkId, target } = edit.ref
        return [
          projectId,
          "edge",
          JSON.stringify([
            source.objectTypeId,
            source.primaryId,
            linkId,
            target.objectTypeId,
            target.primaryId,
          ]),
          source.objectTypeId,
          source.primaryId,
          linkId,
          target.objectTypeId,
          target.primaryId,
          JSON.stringify(edit.value),
          commitId,
          edit.updatedAt,
        ]
      }),
      ...edits.slots.map((edit) => {
        // A cleared slot keeps the target it cleared, as production stores it.
        const target = edit.value.target
        return [
          projectId,
          "slot",
          JSON.stringify([edit.source.objectTypeId, edit.source.primaryId, edit.linkId]),
          edit.source.objectTypeId,
          edit.source.primaryId,
          edit.linkId,
          target.objectTypeId,
          target.primaryId,
          JSON.stringify(edit.value),
          commitId,
          edit.updatedAt,
        ]
      }),
    ])
  }

  #laneOf(table: string): Lane {
    const lane = this.#lanes.find((candidate) => candidate.tables.includes(table))
    if (!lane) throw new Error(`[SixbPg] No snapshot lane loads '${table}'.`)
    return lane
  }

  /** Copy what waits, then build each lane's indexes and statistics, and commit the lanes. */
  async #finish(open: Lane[], state: BranchSchemaState): Promise<void> {
    for (const target of [...this.#pending.keys()]) await this.#flush(target)

    // Each source counts what the load wrote of it, as a ready version does.
    if (this.#sources.size > 0) {
      const lane = this.#laneOf("ontology_sources")
      await onLane(
        lane,
        (sql) => sql`
        UPDATE ontology_sources AS versions
        SET root_count = counted.roots, assertion_count = counted.assertions
        FROM (
          SELECT roots.version_id, count(DISTINCT roots.id) AS roots, count(rows.root_id) AS assertions
          FROM ontology_source_roots AS roots
          LEFT JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
          GROUP BY roots.version_id
        ) AS counted
        WHERE versions.version_id = counted.version_id
      `
      )
    }

    await Promise.all(
      this.#lanes.map(async (lane) => {
        for (const definition of lane.indexes) await onLane(lane, (sql) => sql.unsafe(definition))
        await onLane(lane, (sql) => sql.unsafe(`ANALYZE ${lane.tables.join(", ")}`))
      })
    )

    while (open.length > 0) {
      const lane = open[0]!
      if (open.length === 1) await onLane(lane, (sql) => markState(sql, state))
      await onLane(lane, (sql) => sql.unsafe("COMMIT"))
      open.shift()
    }
  }

  /**
   * Queue rows for their table, and copy them once enough are waiting: one `COPY` costs a round
   * trip and a statement start, so batches of a few thousand rows would be bound by them.
   */
  async #copy(target: string, rows: readonly (readonly (string | null)[])[]): Promise<void> {
    if (rows.length === 0) return

    let text = ""
    for (const row of rows) {
      text += row.map((value) => (value === null ? "\\N" : copyText(value))).join("\t")
      text += "\n"
    }
    await this.#queue(target, [text], false)
  }

  async #queue(target: string, chunks: readonly (string | Uint8Array)[], binary: boolean) {
    if (chunks.length === 0) return

    const pending = this.#pending.get(target) ?? { chunks: [], binary, bytes: 0 }
    pending.chunks.push(...chunks)
    for (const chunk of chunks) pending.bytes += chunk.length
    this.#pending.set(target, pending)

    if (pending.bytes >= COPY_BATCH_BYTES) await this.#flush(target)
  }

  /** Start this table's `COPY` once its lane's previous one is done, without waiting for it. */
  async #flush(target: string): Promise<void> {
    const pending = this.#pending.get(target)
    if (!pending) return
    this.#pending.delete(target)

    const table = target.slice(0, target.indexOf(" "))
    const laneTable = table.startsWith("objects_") ? "objects" : table
    const lane = this.#lanes.find((candidate) => candidate.tables.includes(laneTable))
    if (!lane) throw new Error(`[SixbPg] No snapshot lane loads '${table}'.`)

    // A vector references its object, and a source's row its root: the lane copies the objects,
    // or the roots, waiting before it.
    if (table === "object_vectors") {
      for (const other of [...this.#pending.keys()]) {
        if (other.startsWith("objects_")) await this.#flush(other)
      }
    }
    if (table === "ontology_source_rows") {
      for (const other of [...this.#pending.keys()]) {
        if (other.startsWith("ontology_source_roots ")) await this.#flush(other)
      }
    }

    const chunks = pending.binary
      ? [BINARY_COPY_HEADER, ...pending.chunks, BINARY_COPY_TRAILER]
      : pending.chunks
    const options = pending.binary ? "(FORMAT binary, FREEZE)" : "(FREEZE)"

    // One COPY waits at most, so the rows waiting stay within one batch; its failure is the
    // lane's, which the next statement on it raises.
    await lane.tail
    onLane(lane, (sql) => copyIn(sql, `COPY ${target} FROM STDIN ${options}`, chunks)).catch(
      () => undefined
    )
  }
}

/**
 * One `COPY … FROM STDIN`, settled by what the server answers.
 *
 * postgres.js 3.4.9 resolves a copy's query as soon as it starts, and when the server refuses a
 * row it never calls the stream's final callback: the error is dropped. A query sent once the
 * copy's data is out runs when the server has answered it, and fails when the copy failed, which
 * aborted the lane's transaction. postgres.js refuses that query until the stream has handed it
 * its last chunk, so it is sent again on the next turn until then.
 */
async function copyIn(
  sql: ReservedSQL,
  statement: string,
  chunks: readonly (string | Uint8Array)[]
): Promise<void> {
  const stream = await sql.unsafe(statement).writable()
  for (const chunk of chunks) {
    if (!stream.write(chunk)) await once(stream, "drain")
  }

  const copied = new Promise<"copied">((resolve) => stream.end(() => resolve("copied")))
  for (;;) {
    const answered = sql`SELECT 1`.then(
      () => "answered" as const,
      (error: unknown) => error
    )
    const outcome = await Promise.race([copied, answered])
    if (outcome === "copied" || outcome === "answered") return

    if ((outcome as { code?: unknown } | null)?.code === "COPY_IN_PROGRESS") {
      await new Promise((resolve) => setImmediate(resolve))
      continue
    }

    throw new Error(
      `[SixbPg] PostgreSQL refused a row of the snapshot (${statement.split(" (")[0]}): ${outcome instanceof Error ? outcome.message : String(outcome)}`,
      { cause: outcome }
    )
  }
}

/** Runs `work` on the lane once its statements before are done; one that failed fails it too. */
function onLane<T>(lane: Lane, work: (sql: ReservedSQL) => Promise<T>): Promise<T> {
  lane.queued += 1
  const done = lane.tail
    .then(() => work(lane.connection))
    .finally(() => {
      lane.queued -= 1
    })
  lane.tail = done.then(() => undefined)
  lane.tail.catch(() => undefined)
  return done
}

/** A statement on each open lane with nothing to do, so it never looks idle in its transaction. */
function keepAlive(open: readonly Lane[]): void {
  for (const lane of open) {
    if (lane.queued === 0) onLane(lane, (sql) => sql`SELECT 1`).catch(() => undefined)
  }
}

/** Every `LANE_HEARTBEAT_MS`, or a third of the session's idle limit when that is shorter. */
async function heartbeatMillis(sql: ReservedSQL): Promise<number> {
  const [row] = await sql<{ limit: number }[]>`
    SELECT setting::int AS limit FROM pg_settings
    WHERE name = 'idle_in_transaction_session_timeout'
  `
  const limit = row?.limit ?? 0
  return limit > 0
    ? Math.max(1, Math.min(LANE_HEARTBEAT_MS, Math.floor(limit / 3)))
    : LANE_HEARTBEAT_MS
}

/**
 * A lane's transaction: what its index builds may use, its tables truncated in this transaction,
 * which `COPY … FREEZE` needs, and their secondary indexes dropped until the rows are in.
 */
async function openLane(lane: Lane): Promise<void> {
  const sql = lane.connection
  await sql.unsafe(
    `SET LOCAL statement_timeout = 0; SET LOCAL maintenance_work_mem = '${LANE_MAINTENANCE_WORK_MEM}'; SET LOCAL max_parallel_maintenance_workers = ${LANE_MAINTENANCE_WORKERS}`
  )
  // A vector references its object: its table goes with the objects', or neither truncates.
  await sql.unsafe(`TRUNCATE ${lane.tables.join(", ")}`)
  lane.indexes = await dropSecondaryIndexes(sql, lane.tables)
}

/** A load fills a schema that holds nothing, for any project: truncating it takes no one's rows. */
async function assertEmpty(sql: SQLClient): Promise<void> {
  for (const table of LOADED_TABLES) {
    const [row] = await sql.unsafe(`SELECT 1 FROM ${table} LIMIT 1`)
    if (row) throw snapshotTargetNotEmpty()
  }
}

export async function markState(sql: SQLClient, state: BranchSchemaState): Promise<void> {
  const comment = JSON.stringify(state).replace(/'/g, "''")
  await sql.unsafe(`COMMENT ON SCHEMA "${await currentSchema(sql)}" IS '${comment}'`)
}

async function currentSchema(sql: SQLClient): Promise<string> {
  const [row] = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`
  if (!row) throw new Error("[SixbPg] PostgreSQL named no current schema.")
  return row.schema.replace(/"/g, '""')
}

async function writeCommit(sql: SQLClient, input: SnapshotLoadInput): Promise<void> {
  const { commit, uniqueProperties, projectId } = input

  await insertPgRuntimeCommit(sql, commit)

  if (uniqueProperties.length === 0) return
  await sql`
    INSERT INTO object_unique_properties (
      project_id, object_type_id, property_id, key_kind, key_version, prepared_at
    )
    SELECT ${projectId}, prepared.object_type_id, prepared.property_id, prepared.key_kind,
      prepared.key_version, ${commit.committedAt}
    FROM unnest(
      ${uniqueProperties.map((property) => property.objectTypeId)}::text[],
      ${uniqueProperties.map((property) => property.propertyId)}::text[],
      ${uniqueProperties.map((property) => property.keyKind)}::text[],
      ${uniqueProperties.map((property) => property.keyVersion)}::integer[]
    ) AS prepared(object_type_id, property_id, key_kind, key_version)
  `
}

/**
 * Undo a failed load: what lanes committed, the commit, and the mark. The schema held nothing
 * before, so emptying its tables takes only the load's rows.
 */
async function emptyAgain(
  sql: ReservedSQL,
  input: SnapshotLoadInput,
  state: BranchSchemaState
): Promise<void> {
  await runPgTransactionOn(sql, async () => {
    await sql.unsafe(`TRUNCATE ${LOADED_TABLES.join(", ")}`)
    await sql`DELETE FROM object_unique_properties WHERE project_id = ${input.projectId}`
    await sql`DELETE FROM ontology_commits WHERE project_id = ${input.projectId} AND id = ${input.commit.id}`
    await markState(sql, state)
  })
}

/** Drop every index of these tables that no constraint owns, returning how to build it. */
async function dropSecondaryIndexes(
  sql: SQLClient,
  tables: readonly string[]
): Promise<readonly string[]> {
  const indexes = await sql<{ name: string; definition: string }[]>`
    SELECT index_class.relname AS name, pg_get_indexdef(index_class.oid) AS definition
    FROM pg_index AS entry
    JOIN pg_class AS index_class ON index_class.oid = entry.indexrelid
    JOIN pg_class AS table_class ON table_class.oid = entry.indrelid
    WHERE table_class.relnamespace = current_schema()::regnamespace
      AND table_class.relname = ANY(${tables}::text[])
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = entry.indexrelid)
  `

  for (const index of indexes) {
    await sql.unsafe(`DROP INDEX "${index.name.replace(/"/g, '""')}"`)
  }

  // A partitioned table's index is defined `ON ONLY` the parent: built again that way, it would
  // reach no partition.
  return indexes.map(({ definition }) => definition.replace(" ON ONLY ", " ON "))
}

function byType(objects: readonly SnapshotObjectWrite[]): Map<string, SnapshotObjectWrite[]> {
  const groups = new Map<string, SnapshotObjectWrite[]>()
  for (const object of objects) {
    const group = groups.get(object.objectTypeId) ?? []
    group.push(object)
    groups.set(object.objectTypeId, group)
  }
  return groups
}

/** A value in COPY's text format: backslash, tab, newline and carriage return escaped. */
function copyText(value: string): string {
  if (!/[\\\t\n\r]/.test(value)) return value
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
}

const OBJECT_OVERRIDE_COLUMNS =
  "ontology_object_overrides (project_id, object_type_id, primary_id, value, last_commit_id, updated_at, edited_at)"
const LINK_OVERRIDE_COLUMNS =
  "ontology_link_overrides (project_id, identity_kind, identity_key, source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, value, last_commit_id, updated_at)"

// Vectors load with COPY in its binary format. In text, each of the 1,536 floats of a vector is
// written and parsed as a decimal, which bound a load at a few thousand vectors a second; in
// binary they are four bytes each, written straight into the row.

const BINARY_SIGNATURE = Buffer.from("PGCOPY\n\xff\r\n\0", "latin1")
const BINARY_COPY_HEADER = Buffer.concat([BINARY_SIGNATURE, Buffer.alloc(8)])
const BINARY_COPY_TRAILER = Buffer.from([0xff, 0xff])
const TEXT_OID = 25
const FLOAT4_OID = 700
const ARRAY_HEADER_BYTES = 20

const VECTOR_COLUMNS =
  "object_vectors (project_id, object_type_id, primary_id, profile, configuration, source, source_fingerprint, embedding, last_commit_id)"

/** One `object_vectors` row in binary COPY format, columns as in {@link VECTOR_COLUMNS}. */
function encodeVectorRow(projectId: string, vector: StoredObjectVector, commitId: string): Buffer {
  const texts = [
    projectId,
    vector.ref.objectTypeId,
    vector.ref.primaryId,
    vector.profile,
    vector.configuration,
  ].map((value) => Buffer.from(value, "utf8"))
  const source = vector.source.map((value) => Buffer.from(value, "utf8"))
  const fingerprint = Buffer.from(vector.sourceFingerprint, "utf8")
  const commit = Buffer.from(commitId, "utf8")

  const sourceBytes =
    ARRAY_HEADER_BYTES + source.reduce((total, item) => total + 4 + item.length, 0)
  const embeddingBytes = ARRAY_HEADER_BYTES + vector.values.length * 8
  const fields = 9
  const size =
    2 +
    fields * 4 +
    texts.reduce((total, item) => total + item.length, 0) +
    sourceBytes +
    fingerprint.length +
    embeddingBytes +
    commit.length

  const row = Buffer.alloc(size)
  const view = new DataView(row.buffer, row.byteOffset, row.byteLength)
  let offset = 0
  const int32 = (value: number) => {
    view.setInt32(offset, value)
    offset += 4
  }
  const bytes = (value: Buffer) => {
    int32(value.length)
    offset += value.copy(row, offset)
  }
  const arrayHeader = (bytesLength: number, elementOid: number, count: number) => {
    int32(bytesLength)
    int32(1)
    int32(0)
    int32(elementOid)
    int32(count)
    int32(1)
  }

  view.setInt16(offset, fields)
  offset += 2
  for (const text of texts) bytes(text)

  arrayHeader(sourceBytes, TEXT_OID, source.length)
  for (const item of source) bytes(item)

  bytes(fingerprint)

  arrayHeader(embeddingBytes, FLOAT4_OID, vector.values.length)
  for (const value of vector.values) {
    int32(4)
    view.setFloat32(offset, value)
    offset += 4
  }

  bytes(commit)
  return row
}
