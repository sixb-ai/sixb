import type { Database, Statement } from "bun:sqlite"
import {
  sourceAssertionPayload,
  sourceEntityColumns,
} from "@sixb/core/internal/ontology-storage-provider"
import { snapshotEditedAt, snapshotTargetNotEmpty } from "@sixb/core/internal/storage"
import type {
  SnapshotLoadBatch,
  SnapshotLoadInput,
  SnapshotSourceRootWrite,
  SnapshotSourceWrite,
  SnapshotTypeEdits,
} from "@sixb/core/storage"
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
  "ontology_sources",
  "ontology_source_roots",
  "ontology_source_rows",
]

const OBJECT_OVERRIDE_COLUMNS =
  "ontology_object_overrides (project_id, object_type_id, primary_id, value, edited_at, last_commit_id, updated_at)"
const LINK_OVERRIDE_COLUMNS =
  "ontology_link_overrides (project_id, identity_kind, identity_key, source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, value, last_commit_id, updated_at)"

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
  /** Each source taken over, by projection: its version id. */
  readonly #sources = new Map<string, number>()

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

    for (const source of batch.sources ?? []) this.#writeSource(source)
    if (batch.sourceRoots?.length) this.#writeSourceRoots(batch.sourceRoots)
    if (batch.edits) this.#writeEdits(batch.edits)

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
      OBJECT_OVERRIDE_COLUMNS,
      objects.flatMap((row) =>
        row.override
          ? [
              [
                projectId,
                row.objectTypeId,
                row.primaryId,
                JSON.stringify(row.override),
                JSON.stringify(snapshotEditedAt(row.override.properties, row.updatedAt)),
                commitId,
                row.updatedAt,
              ],
            ]
          : []
      )
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

  /** A source taken over: its version, active as of the base commit. */
  #writeSource(source: SnapshotSourceWrite): void {
    const { commit, projectId } = this.#input
    const row = this.#db
      .query<{ version_id: number }, Value[]>(
        `INSERT INTO ontology_sources (
           project_id, source_id, materialization_id, projection_run_id, projection_kind,
           protocol, status, execution_token, dataset_id, dataset_version_id,
           dataset_version_created_at, projection_revision, ownership_hash, ontology_revision,
           root_count, assertion_count, created_at, ready_at, activated_at, last_commit_id,
           updated_at
         ) VALUES (?, ?, ?, ?, 'object', 'replacement', 'active', NULL, ?, ?, ?, ?, ?, ?, 0, 0,
           ?, ?, ?, ?, ?)
         RETURNING version_id`
      )
      .get(
        projectId,
        source.projectionId,
        source.materializationId,
        commit.id,
        source.datasetVersion.datasetId,
        source.datasetVersion.versionId,
        source.datasetVersion.createdAt,
        source.projectionRevision,
        source.ownershipHash,
        source.ontologyRevision,
        commit.committedAt,
        commit.committedAt,
        commit.committedAt,
        commit.id,
        commit.committedAt
      )
    if (!row) throw new Error("[SixbSqlite] SQLite returned no source version.")
    this.#sources.set(source.projectionId, row.version_id)
  }

  /** Roots, then what each asserts, by the root's id. */
  #writeSourceRoots(roots: readonly SnapshotSourceRootWrite[]): void {
    const projectId = this.#input.projectId
    const versionOf = (root: SnapshotSourceRootWrite) => {
      const versionId = this.#sources.get(root.projectionId)
      if (versionId === undefined) {
        throw new Error(`[SixbSqlite] Source '${root.projectionId}' was not loaded first.`)
      }
      return versionId
    }

    this.#insert(
      "ontology_source_roots (version_id, project_id, root_key, staging_ordinal)",
      roots.map((root) => [versionOf(root), projectId, root.rootKey, root.stagingOrdinal])
    )

    const ids = new Map(
      this.#db
        .query<{ id: number; version_id: number; root_key: string }, [string]>(
          `SELECT roots.id, roots.version_id, roots.root_key
           FROM json_each(?) AS requested
           JOIN ontology_source_roots AS roots
             ON roots.version_id = requested.value ->> 0 AND roots.root_key = requested.value ->> 1`
        )
        .all(JSON.stringify(roots.map((root) => [versionOf(root), root.rootKey])))
        .map((row) => [`${row.version_id}:${row.root_key}`, row.id] as const)
    )

    this.#insert(
      "ontology_source_rows (root_id, entity_kind, object_type_id, primary_id, source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, payload)",
      roots.flatMap((root) => {
        const rootId = ids.get(`${versionOf(root)}:${root.rootKey}`)!
        return root.assertions.map((assertion) => {
          const entity = sourceEntityColumns(assertion)
          const payload = sourceAssertionPayload(assertion)
          return [
            rootId,
            assertion.kind,
            entity.objectTypeId,
            entity.primaryId,
            entity.sourceTypeId,
            entity.sourcePrimaryId,
            entity.linkId,
            entity.targetTypeId,
            entity.targetPrimaryId,
            payload === null ? null : JSON.stringify(payload),
          ]
        })
      })
    )
  }

  /** The edits over types loaded as their sources, as production stored them. */
  #writeEdits(edits: SnapshotTypeEdits): void {
    const { projectId } = this.#input
    const commitId = this.#input.commit.id

    this.#insert(
      OBJECT_OVERRIDE_COLUMNS,
      edits.objects.map((edit) => [
        projectId,
        edit.ref.objectTypeId,
        edit.ref.primaryId,
        JSON.stringify(edit.value),
        JSON.stringify(edit.editedAt ?? {}),
        commitId,
        edit.updatedAt,
      ])
    )
    this.#insert(LINK_OVERRIDE_COLUMNS, [
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
      ...edits.slots.map((edit) => [
        projectId,
        "slot",
        JSON.stringify([edit.source.objectTypeId, edit.source.primaryId, edit.linkId]),
        edit.source.objectTypeId,
        edit.source.primaryId,
        edit.linkId,
        edit.value.target.objectTypeId,
        edit.value.target.primaryId,
        JSON.stringify(edit.value),
        commitId,
        edit.updatedAt,
      ]),
    ])
  }

  /** Build the indexes dropped for the load, then the statistics the planner reads. */
  finish(): void {
    // Each source counts what the load wrote of it, as a ready version does.
    this.#db.run(
      `UPDATE ontology_sources SET
         root_count = (SELECT count(*) FROM ontology_source_roots AS roots
           WHERE roots.version_id = ontology_sources.version_id),
         assertion_count = (SELECT count(*) FROM ontology_source_rows AS rows
           JOIN ontology_source_roots AS roots ON roots.id = rows.root_id
           WHERE roots.version_id = ontology_sources.version_id)
       WHERE status = 'active' AND last_commit_id = ?`,
      [this.#input.commit.id]
    )
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
