import type { Database } from "bun:sqlite"
import {
  linkRefKey,
  MaterializationConflictError,
  objectRefKey,
  telemetryPointKey,
} from "@sixb/core/internal/materialization"
import { effectiveConflict } from "@sixb/core/internal/ontology-storage-provider"
import type {
  ExactEffectiveLinkWrite,
  ExactEffectiveObjectWrite,
  MaterializationPlanChunk,
} from "@sixb/core/storage"
import { assertTimestamp, canonicalJson, isSqliteConstraintError, requireChanges } from "./shared"

function linkOverrideConflictMessage(identityKind: "edge" | "slot"): string {
  return identityKind === "edge"
    ? "Expected link edge override changed."
    : "Expected link slot override changed."
}

function linkOverrideConflict(identityKind: "edge" | "slot"): MaterializationConflictError {
  return effectiveConflict(linkOverrideConflictMessage(identityKind))
}

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
    for (const item of chunk.overrides.objects.upserts) {
      if (item.expectedLastCommitId === null) {
        try {
          this.db
            .query(
              `INSERT INTO ontology_object_overrides (
                 project_id, object_type_id, primary_id, value, last_commit_id, updated_at
               ) VALUES (?, ?, ?, json(?), ?, ?)`
            )
            .run(
              projectId,
              item.ref.objectTypeId,
              item.ref.primaryId,
              canonicalJson(item.value),
              item.lastCommitId,
              item.updatedAt
            )
        } catch (error) {
          if (isSqliteConstraintError(error)) {
            throw effectiveConflict("Expected object override changed.")
          }
          throw error
        }
        continue
      }
      requireChanges(
        this.db
          .query(
            `UPDATE ontology_object_overrides
             SET value = json(?), last_commit_id = ?, updated_at = ?
             WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
               AND last_commit_id = ?`
          )
          .run(
            canonicalJson(item.value),
            item.lastCommitId,
            item.updatedAt,
            projectId,
            item.ref.objectTypeId,
            item.ref.primaryId,
            item.expectedLastCommitId
          ).changes,
        "effective-state",
        "Expected object override changed."
      )
    }
    for (const item of chunk.overrides.objects.deletes) {
      requireChanges(
        this.db
          .query(
            `DELETE FROM ontology_object_overrides
             WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
               AND last_commit_id = ?`
          )
          .run(projectId, item.ref.objectTypeId, item.ref.primaryId, item.expectedLastCommitId)
          .changes,
        "effective-state",
        "Expected object override changed."
      )
    }

    const upsertLink = (
      identityKind: "edge" | "slot",
      identityKey: string,
      ref: {
        readonly source: { readonly objectTypeId: string; readonly primaryId: string }
        readonly linkId: string
        readonly target: { readonly objectTypeId: string; readonly primaryId: string }
      },
      item:
        | (typeof chunk.overrides.links.edges.upserts)[number]
        | (typeof chunk.overrides.links.slots.upserts)[number]
    ): void => {
      if (item.expectedLastCommitId === null) {
        try {
          this.db
            .query(
              `INSERT INTO ontology_link_overrides (
                 project_id, identity_kind, identity_key,
                 source_type_id, source_primary_id, link_id,
                 target_type_id, target_primary_id, value, last_commit_id, updated_at
               ) VALUES (?, ?, json(?), ?, ?, ?, ?, ?, json(?), ?, ?)`
            )
            .run(
              projectId,
              identityKind,
              identityKey,
              ref.source.objectTypeId,
              ref.source.primaryId,
              ref.linkId,
              ref.target.objectTypeId,
              ref.target.primaryId,
              canonicalJson(item.value),
              item.lastCommitId,
              item.updatedAt
            )
        } catch (error) {
          if (isSqliteConstraintError(error)) {
            throw linkOverrideConflict(identityKind)
          }
          throw error
        }
        return
      }
      requireChanges(
        this.db
          .query(
            `UPDATE ontology_link_overrides
             SET target_type_id = ?, target_primary_id = ?, value = json(?),
               last_commit_id = ?, updated_at = ?
             WHERE project_id = ? AND identity_kind = ? AND identity_key = json(?)
               AND last_commit_id = ?`
          )
          .run(
            ref.target.objectTypeId,
            ref.target.primaryId,
            canonicalJson(item.value),
            item.lastCommitId,
            item.updatedAt,
            projectId,
            identityKind,
            identityKey,
            item.expectedLastCommitId
          ).changes,
        "effective-state",
        linkOverrideConflictMessage(identityKind)
      )
    }

    for (const item of chunk.overrides.links.edges.upserts) {
      upsertLink("edge", linkRefKey(item.ref), item.ref, item)
    }
    for (const item of chunk.overrides.links.slots.upserts) {
      upsertLink(
        "slot",
        JSON.stringify([item.ref.source.objectTypeId, item.ref.source.primaryId, item.ref.linkId]),
        { source: item.ref.source, linkId: item.ref.linkId, target: item.value.target },
        item
      )
    }

    const deleteLink = (
      identityKind: "edge" | "slot",
      identityKey: string,
      expectedLastCommitId: string
    ): void => {
      requireChanges(
        this.db
          .query(
            `DELETE FROM ontology_link_overrides
             WHERE project_id = ? AND identity_kind = ? AND identity_key = json(?)
               AND last_commit_id = ?`
          )
          .run(projectId, identityKind, identityKey, expectedLastCommitId).changes,
        "effective-state",
        linkOverrideConflictMessage(identityKind)
      )
    }
    for (const item of chunk.overrides.links.edges.deletes) {
      deleteLink("edge", linkRefKey(item.ref), item.expectedLastCommitId)
    }
    for (const item of chunk.overrides.links.slots.deletes) {
      deleteLink(
        "slot",
        JSON.stringify([item.ref.source.objectTypeId, item.ref.source.primaryId, item.ref.linkId]),
        item.expectedLastCommitId
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
