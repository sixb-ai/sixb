import type { Database } from "bun:sqlite"
import {
  uniquePropertyNotPrepared,
  uniqueValueViolation,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  ExactUniqueValueClaim,
  ExactUniqueValueWrite,
  OntologyUniqueValueStorage,
  PreparedUniqueProperty,
  UniqueValueEntry,
  UniqueValueRef,
} from "@sixb/core/storage"
import type { SqliteRootOperation } from "./shared"

/** The object holding a unique value, or null when none does. */
export function sqliteUniqueHolder(
  db: Database,
  projectId: string,
  value: UniqueValueRef
): string | null {
  const row = db
    .query(
      `SELECT primary_id FROM object_unique_values
       WHERE project_id = ? AND object_type_id = ? AND property_id = ? AND value_key = ?`
    )
    .get(projectId, value.objectTypeId, value.propertyId, value.valueKey) as {
    readonly primary_id: string
  } | null
  return row?.primary_id ?? null
}

/** Gives the value to its object, unless another object holds it. */
export function claimSqliteUniqueValue(
  db: Database,
  projectId: string,
  value: ExactUniqueValueWrite
): void {
  const holder = sqliteUniqueHolder(db, projectId, value)
  if (holder === value.primaryId) return
  if (holder !== null) throw uniqueValueViolation(value, holder, value.primaryId)

  db.query(
    `INSERT INTO object_unique_values (
       project_id, object_type_id, property_id, value_key, primary_id
     ) VALUES (?, ?, ?, ?, ?)`
  ).run(projectId, value.objectTypeId, value.propertyId, value.valueKey, value.primaryId)
}

/**
 * Refuses claims on a property whose values were not built with the claims' keys. Each property
 * is checked once per call, however many of its values the claims take.
 */
export function assertSqliteUniquePrepared(
  db: Database,
  projectId: string,
  claims: readonly ExactUniqueValueClaim[]
): void {
  const checked = new Set<string>()
  const prepared = db.query(
    `SELECT 1 FROM object_unique_properties
     WHERE project_id = ? AND object_type_id = ? AND property_id = ?
       AND key_kind = ? AND key_version = ?`
  )

  for (const claim of claims) {
    const key = JSON.stringify([
      claim.objectTypeId,
      claim.propertyId,
      claim.keyKind,
      claim.keyVersion,
    ])
    if (checked.has(key)) continue
    checked.add(key)

    const row = prepared.get(
      projectId,
      claim.objectTypeId,
      claim.propertyId,
      claim.keyKind,
      claim.keyVersion
    )
    if (!row) throw uniquePropertyNotPrepared(claim)
  }
}

/** Drops the value if its object still holds it. */
export function releaseSqliteUniqueValue(
  db: Database,
  projectId: string,
  value: ExactUniqueValueWrite
): void {
  db.query(
    `DELETE FROM object_unique_values
     WHERE project_id = ? AND object_type_id = ? AND property_id = ? AND value_key = ?
       AND primary_id = ?`
  ).run(projectId, value.objectTypeId, value.propertyId, value.valueKey, value.primaryId)
}

export class SqliteOntologyUniqueValueStorage implements OntologyUniqueValueStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  /** A SQLite database has one writer at a time: preparers already take turns. */
  async lockPreparation(_input: { readonly projectId: string }): Promise<void> {}

  async listPrepared(input: {
    readonly projectId: string
  }): Promise<readonly PreparedUniqueProperty[]> {
    return this.runRootOperation(() => {
      const rows = this.db
        .query(
          `SELECT object_type_id, property_id, key_kind, key_version FROM object_unique_properties
           WHERE project_id = ?
           ORDER BY object_type_id, property_id`
        )
        .all(input.projectId) as {
        readonly object_type_id: string
        readonly property_id: string
        readonly key_kind: PreparedUniqueProperty["keyKind"]
        readonly key_version: number
      }[]
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
    await this.runRootOperation(() => {
      for (const table of ["object_unique_values", "object_unique_properties"]) {
        this.db
          .query(
            `DELETE FROM ${table} WHERE project_id = ? AND object_type_id = ? AND property_id = ?`
          )
          .run(input.projectId, input.objectTypeId, input.propertyId)
      }
    })
  }

  async insert(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly propertyId: string
    readonly entries: readonly UniqueValueEntry[]
  }): Promise<void> {
    const { projectId, objectTypeId, propertyId } = input
    await this.runRootOperation(() => {
      for (const entry of input.entries) {
        claimSqliteUniqueValue(this.db, projectId, { objectTypeId, propertyId, ...entry })
      }
    })
  }

  async markPrepared(
    input: PreparedUniqueProperty & { readonly projectId: string; readonly preparedAt: string }
  ): Promise<void> {
    await this.runRootOperation(() => {
      this.db
        .query(
          `INSERT INTO object_unique_properties (
             project_id, object_type_id, property_id, key_kind, key_version, prepared_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, object_type_id, property_id)
           DO UPDATE SET key_kind = excluded.key_kind, key_version = excluded.key_version,
             prepared_at = excluded.prepared_at`
        )
        .run(
          input.projectId,
          input.objectTypeId,
          input.propertyId,
          input.keyKind,
          input.keyVersion,
          input.preparedAt
        )
    })
  }
}
