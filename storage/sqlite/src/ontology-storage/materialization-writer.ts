import type { Database } from "bun:sqlite"
import {
  linkRefKey,
  MaterializationConflictError,
  objectRefKey,
  telemetryPointKey,
} from "@sixb/core/internal/materialization"
import {
  effectiveConflict,
  type OverrideEntity,
  overrideEntityColumns as overrideColumns,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  ExactEffectiveLinkWrite,
  ExactEffectiveObjectWrite,
  MaterializationPlanChunk,
} from "@sixb/core/storage"
import { assertTimestamp, canonicalJson, isSqliteConstraintError, requireChanges } from "./shared"

/** Applies one already-validated exact plan chunk to SQLite authority tables. */
export class SqliteMaterializationWriter {
  constructor(private readonly db: Database) {}

  apply(projectId: string, commitId: string, chunk: MaterializationPlanChunk): void {
    this.applyOverrides(projectId, chunk)
    this.applyEffective(projectId, chunk)
    this.applyTimeseries(projectId, chunk)
    this.applyOutbox(projectId, commitId, chunk)
  }

  private applyOverrides(projectId: string, chunk: MaterializationPlanChunk): void {
    const upsert = (
      entity: OverrideEntity,
      item:
        | (typeof chunk.overrides.objectUpserts)[number]
        | (typeof chunk.overrides.linkUpserts)[number]
    ): void => {
      const kind = entity.kind
      const key = kind === "object" ? objectRefKey(entity.ref) : linkRefKey(entity.ref)
      const columns = overrideColumns(entity)
      if (item.expectedLastCommitId === null) {
        try {
          this.db
            .query(
              `
                INSERT INTO ontology_overrides (
                  project_id, entity_kind, entity_key, entity_sort_key,
                  object_type_id, primary_id, source_type_id, source_primary_id,
                  link_id, target_type_id, target_primary_id,
                  value, last_commit_id, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), ?, ?)
              `
            )
            .run(
              projectId,
              kind,
              key,
              columns.sortKey,
              columns.objectTypeId,
              columns.primaryId,
              columns.sourceTypeId,
              columns.sourcePrimaryId,
              columns.linkId,
              columns.targetTypeId,
              columns.targetPrimaryId,
              canonicalJson(item.value),
              item.lastCommitId,
              item.updatedAt
            )
        } catch (error) {
          if (isSqliteConstraintError(error)) {
            throw effectiveConflict(`Expected ${kind} override changed.`)
          }
          throw error
        }
      } else {
        requireChanges(
          this.db
            .query(
              `
                UPDATE ontology_overrides
                SET value = json(?), last_commit_id = ?, updated_at = ?
                WHERE project_id = ? AND entity_kind = ? AND entity_key = ?
                  AND last_commit_id = ?
              `
            )
            .run(
              canonicalJson(item.value),
              item.lastCommitId,
              item.updatedAt,
              projectId,
              kind,
              key,
              item.expectedLastCommitId
            ).changes,
          "effective-state",
          `Expected ${kind} override changed.`
        )
      }
    }
    for (const item of chunk.overrides.objectUpserts) {
      upsert({ kind: "object", ref: item.ref }, item)
    }
    for (const item of chunk.overrides.objectDeletes) {
      requireChanges(
        this.db
          .query(
            `DELETE FROM ontology_overrides
             WHERE project_id = ? AND entity_kind = 'object' AND entity_key = ? AND last_commit_id = ?`
          )
          .run(projectId, objectRefKey(item.ref), item.expectedLastCommitId).changes,
        "effective-state",
        "Expected object override changed."
      )
    }
    for (const item of chunk.overrides.linkUpserts) {
      upsert({ kind: "link", ref: item.ref }, item)
    }
    for (const item of chunk.overrides.linkDeletes) {
      requireChanges(
        this.db
          .query(
            `DELETE FROM ontology_overrides
             WHERE project_id = ? AND entity_kind = 'link' AND entity_key = ? AND last_commit_id = ?`
          )
          .run(projectId, linkRefKey(item.ref), item.expectedLastCommitId).changes,
        "effective-state",
        "Expected link override changed."
      )
    }
  }

  private applyEffective(projectId: string, chunk: MaterializationPlanChunk): void {
    for (const item of chunk.effective.linkDeletes) {
      requireChanges(
        this.db
          .query(
            `
              DELETE FROM links
              WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
                AND target_type_id = ? AND target_id = ? AND last_commit_id = ?
            `
          )
          .run(
            projectId,
            item.ref.source.objectTypeId,
            item.ref.source.primaryId,
            item.ref.linkId,
            item.ref.target.objectTypeId,
            item.ref.target.primaryId,
            item.expected.lastCommitId
          ).changes,
        "effective-state",
        `Expected link ${linkRefKey(item.ref)} changed.`
      )
    }
    for (const item of chunk.effective.objectDeletes) {
      requireChanges(
        this.db
          .query(
            `DELETE FROM objects
             WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
               AND version = ? AND last_commit_id = ?`
          )
          .run(
            projectId,
            item.ref.objectTypeId,
            item.ref.primaryId,
            item.expected.version,
            item.expected.lastCommitId
          ).changes,
        "effective-state",
        `Expected object ${objectRefKey(item.ref)} changed.`
      )
    }
    for (const item of chunk.effective.objectUpserts) this.applyObject(projectId, item)
    for (const item of chunk.effective.linkUpserts) this.applyLink(projectId, item)
  }

  private applyObject(projectId: string, item: ExactEffectiveObjectWrite): void {
    const { row, expected } = item
    if (!expected.exists) {
      try {
        this.db
          .query(
            `
              INSERT INTO objects (
                project_id, object_type_id, primary_id, properties, created_at,
                updated_at, version, last_commit_id
              ) VALUES (?, ?, ?, json(?), ?, ?, ?, ?)
            `
          )
          .run(
            projectId,
            row.ref.objectTypeId,
            row.ref.primaryId,
            canonicalJson(row.properties),
            row.createdAt,
            row.updatedAt,
            row.version,
            row.lastCommitId
          )
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw effectiveConflict(`Expected object ${objectRefKey(row.ref)} to be absent.`)
        }
        throw error
      }
      return
    }
    requireChanges(
      this.db
        .query(
          `
            UPDATE objects
            SET properties = json(?), created_at = ?, updated_at = ?, version = ?,
              last_commit_id = ?
            WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
              AND version = ? AND last_commit_id = ?
          `
        )
        .run(
          canonicalJson(row.properties),
          row.createdAt,
          row.updatedAt,
          row.version,
          row.lastCommitId,
          projectId,
          row.ref.objectTypeId,
          row.ref.primaryId,
          expected.version,
          expected.lastCommitId
        ).changes,
      "effective-state",
      `Expected object ${objectRefKey(row.ref)} changed.`
    )
  }

  private applyLink(projectId: string, item: ExactEffectiveLinkWrite): void {
    const { row, expected } = item
    if (!expected.exists) {
      try {
        this.db
          .query(
            `
              INSERT INTO links (
                project_id, source_type_id, source_id, link_id, target_type_id, target_id,
                properties, created_at, updated_at, last_commit_id
              ) VALUES (?, ?, ?, ?, ?, ?, json(?), ?, ?, ?)
            `
          )
          .run(
            projectId,
            row.ref.source.objectTypeId,
            row.ref.source.primaryId,
            row.ref.linkId,
            row.ref.target.objectTypeId,
            row.ref.target.primaryId,
            row.properties === undefined ? null : canonicalJson(row.properties),
            row.createdAt,
            row.updatedAt,
            row.lastCommitId
          )
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw effectiveConflict(`Expected link ${linkRefKey(row.ref)} to be absent.`)
        }
        throw error
      }
      return
    }
    requireChanges(
      this.db
        .query(
          `
            UPDATE links
            SET properties = json(?), created_at = ?, updated_at = ?,
              last_commit_id = ?
            WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
              AND target_type_id = ? AND target_id = ? AND last_commit_id = ?
          `
        )
        .run(
          row.properties === undefined ? null : canonicalJson(row.properties),
          row.createdAt,
          row.updatedAt,
          row.lastCommitId,
          projectId,
          row.ref.source.objectTypeId,
          row.ref.source.primaryId,
          row.ref.linkId,
          row.ref.target.objectTypeId,
          row.ref.target.primaryId,
          expected.lastCommitId
        ).changes,
      "effective-state",
      `Expected link ${linkRefKey(row.ref)} changed.`
    )
  }

  private applyTimeseries(projectId: string, chunk: MaterializationPlanChunk): void {
    for (const item of chunk.timeseries.pointUpserts) {
      const { point, expected } = item
      if (expected.lastCommitId === null) {
        try {
          this.db
            .query(
              `
                INSERT INTO timeseries (
                  project_id, object_type_id, object_id, property_id,
                  value, unit, at, last_commit_id
                ) VALUES (?, ?, ?, ?, json(?), ?, ?, ?)
              `
            )
            .run(
              projectId,
              point.series.object.objectTypeId,
              point.series.object.primaryId,
              point.series.propertyId,
              canonicalJson(point.value),
              point.unit ?? null,
              point.at,
              point.lastCommitId
            )
        } catch (error) {
          if (isSqliteConstraintError(error)) {
            throw new MaterializationConflictError(
              "timeseries-point",
              `Telemetry point ${telemetryPointKey(point.series, point.at)} changed.`
            )
          }
          throw error
        }
      } else {
        requireChanges(
          this.db
            .query(
              `
                UPDATE timeseries
                SET value = json(?), unit = ?, last_commit_id = ?
                WHERE project_id = ? AND object_type_id = ? AND object_id = ?
                  AND property_id = ? AND at = ? AND last_commit_id = ?
              `
            )
            .run(
              canonicalJson(point.value),
              point.unit ?? null,
              point.lastCommitId,
              projectId,
              point.series.object.objectTypeId,
              point.series.object.primaryId,
              point.series.propertyId,
              point.at,
              expected.lastCommitId
            ).changes,
          "timeseries-point",
          `Telemetry point ${telemetryPointKey(point.series, point.at)} changed.`
        )
      }
    }
  }

  private applyOutbox(projectId: string, commitId: string, chunk: MaterializationPlanChunk): void {
    const insert = this.db.query(
      `
        INSERT INTO ontology_outbox (
          project_id, id, commit_id, commit_ordinal, envelope,
          available_at, attempts, lease_id, lease_expires_at,
          published_at, last_error, created_at
        ) VALUES (?, ?, ?, ?, json(?), ?, 0, NULL, NULL, NULL, NULL, ?)
      `
    )
    for (const item of chunk.outbox) {
      assertTimestamp(item.availableAt, "Outbox availableAt")
      assertTimestamp(item.createdAt, "Outbox createdAt")
      try {
        insert.run(
          projectId,
          item.envelope.id,
          commitId,
          item.envelope.commitOrdinal,
          canonicalJson(item.envelope),
          item.availableAt,
          item.createdAt
        )
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw effectiveConflict(`Duplicate outbox event '${item.envelope.id}'.`)
        }
        throw error
      }
    }
  }
}
