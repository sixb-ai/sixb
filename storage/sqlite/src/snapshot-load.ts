import type { Database, Statement } from "bun:sqlite"
import { snapshotEditedAt, snapshotTargetNotEmpty } from "@sixb/core/internal/storage"
import type { SnapshotLoadBatch, SnapshotLoadInput } from "@sixb/core/storage"
import { encodeSqliteVector } from "./vector-encoding"

/** Tables a snapshot fills: their secondary indexes are built once, after the load. */
const LOADED_TABLES = [
  "objects",
  "links",
  "ontology_object_overrides",
  "ontology_link_overrides",
  "timeseries",
  "object_unique_values",
  "object_artifact_refs",
  "object_vectors",
]

/** Rows per statement: one statement per row costs more than the row itself. */
const ROWS_PER_STATEMENT = 200

type Value = string | number | null | Uint8Array

/**
 * Writes a snapshot into an empty SQLite database inside the caller's transaction: the commit
 * first, then each batch with multi-row inserts, with secondary indexes dropped meanwhile and
 * built again at the end, before `ANALYZE`.
 */
export class SqliteSnapshotLoad {
  readonly #db: Database
  readonly #input: SnapshotLoadInput
  readonly #indexes: readonly string[]
  readonly #statements = new Map<string, Statement>()

  constructor(db: Database, input: SnapshotLoadInput) {
    this.#db = db
    this.#input = input

    for (const table of LOADED_TABLES) {
      if (db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw snapshotTargetNotEmpty()
    }

    this.#indexes = dropSecondaryIndexes(db)
    this.#writeCommit()
  }

  write(batch: SnapshotLoadBatch): void {
    const projectId = this.#input.projectId
    const commitId = this.#input.commit.id
    const objects = batch.objects ?? []
    const links = batch.links ?? []

    this.#insert(
      "objects (project_id, object_type_id, primary_id, properties, created_at, updated_at, version, last_commit_id)",
      objects.map((row) => [
        projectId,
        row.objectTypeId,
        row.primaryId,
        JSON.stringify(row.properties),
        row.createdAt,
        row.updatedAt,
        1,
        commitId,
      ])
    )
    this.#insert(
      "ontology_object_overrides (project_id, object_type_id, primary_id, value, edited_at, last_commit_id, updated_at)",
      objects.map((row) => [
        projectId,
        row.objectTypeId,
        row.primaryId,
        JSON.stringify(row.override),
        JSON.stringify(snapshotEditedAt(row.override.properties, row.updatedAt)),
        commitId,
        row.updatedAt,
      ])
    )

    this.#insert(
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
    this.#insert(
      "ontology_link_overrides (project_id, identity_kind, identity_key, source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, value, last_commit_id, updated_at)",
      links.map((row) => {
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

    // SQLite keeps no table of latest points: the latest is the whole series a snapshot carries.
    this.#insert(
      "timeseries (project_id, object_type_id, object_id, property_id, value, unit, at, last_commit_id)",
      (batch.points ?? []).map((row) => [
        projectId,
        row.objectTypeId,
        row.objectId,
        row.propertyId,
        JSON.stringify(row.value),
        row.unit ?? null,
        row.at,
        commitId,
      ])
    )
    this.#insert(
      "object_unique_values (project_id, object_type_id, property_id, value_key, primary_id)",
      (batch.uniqueValues ?? []).map((row) => [
        projectId,
        row.objectTypeId,
        row.propertyId,
        row.valueKey,
        row.primaryId,
      ])
    )
    this.#insert(
      "object_artifact_refs (project_id, artifact_id, object_type_id, primary_id, property_id)",
      (batch.artifactHolders ?? []).map((row) => [
        projectId,
        row.artifactId,
        row.objectTypeId,
        row.primaryId,
        row.propertyId,
      ])
    )
    this.#insert(
      "object_vectors (project_id, object_type_id, primary_id, profile, configuration, source, source_fingerprint, embedding, last_commit_id)",
      (batch.vectors ?? []).map((row) => [
        projectId,
        row.ref.objectTypeId,
        row.ref.primaryId,
        row.profile,
        row.configuration,
        JSON.stringify(row.source),
        row.sourceFingerprint,
        encodeSqliteVector(row.values),
        commitId,
      ])
    )
  }

  /** Build the indexes dropped for the load, then the statistics the planner reads. */
  finish(): void {
    for (const statement of this.#indexes) this.#db.run(statement)
    this.#db.run("ANALYZE")
  }

  /** Insert rows in statements of {@link ROWS_PER_STATEMENT}, each prepared once per size. */
  #insert(target: string, rows: readonly (readonly Value[])[]): void {
    for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
      const chunk = rows.slice(start, start + ROWS_PER_STATEMENT)
      this.#statement(target, chunk.length, chunk[0]!.length).run(...chunk.flat())
    }
  }

  #statement(target: string, rows: number, columns: number): Statement {
    const key = `${rows}:${target}`
    let statement = this.#statements.get(key)
    if (!statement) {
      const row = `(${Array.from({ length: columns }, () => "?").join(", ")})`
      statement = this.#db.prepare(
        `INSERT INTO ${target} VALUES ${Array.from({ length: rows }, () => row).join(", ")}`
      )
      this.#statements.set(key, statement)
    }
    return statement
  }

  #writeCommit(): void {
    const { commit, uniqueProperties, projectId } = this.#input

    this.#db
      .query(
        `INSERT INTO ontology_commits (
           project_id, id, idempotency_key, request_hash, execution_id,
           origin_kind, origin_run_id, origin_batch_ordinal, origin,
           ontology_revision, projection_revision, ownership_hash,
           intent, result, committed_at
         ) VALUES (?, ?, ?, ?, ?, 'runtime', NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?)`
      )
      .run(
        projectId,
        commit.id,
        commit.idempotencyKey,
        commit.requestHash,
        commit.executionId,
        JSON.stringify(commit.origin),
        commit.ontologyRevision,
        JSON.stringify(commit.intent),
        JSON.stringify(commit.result),
        commit.committedAt
      )

    this.#insert(
      "object_unique_properties (project_id, object_type_id, property_id, key_kind, key_version, prepared_at)",
      uniqueProperties.map((property) => [
        projectId,
        property.objectTypeId,
        property.propertyId,
        property.keyKind,
        property.keyVersion,
        commit.committedAt,
      ])
    )
  }
}

function dropSecondaryIndexes(db: Database): readonly string[] {
  const indexes = db
    .query<{ name: string; sql: string }, []>(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND sql IS NOT NULL
         AND tbl_name IN (${LOADED_TABLES.map((table) => `'${table}'`).join(", ")})`
    )
    .all()

  for (const index of indexes) db.run(`DROP INDEX "${index.name}"`)
  return indexes.map((index) => index.sql)
}
