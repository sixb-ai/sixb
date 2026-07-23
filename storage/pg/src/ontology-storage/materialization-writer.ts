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
import type { MaterializationPlanChunk } from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { assertTimestamp, jsonParameter } from "./shared"

/** Applies one already-validated exact plan chunk in bounded PostgreSQL batches. */
export class PgMaterializationWriter {
  constructor(private readonly sql: SQLClient) {}

  async apply(projectId: string, commitId: string, chunk: MaterializationPlanChunk): Promise<void> {
    await this.applyOverrides(projectId, chunk)
    await this.applyEffective(projectId, chunk)
    await this.applyTimeseries(projectId, chunk)
    await this.applyOutbox(projectId, commitId, chunk)
  }

  private async applyOverrides(projectId: string, chunk: MaterializationPlanChunk): Promise<void> {
    const upserts = [
      ...chunk.overrides.objectUpserts.map((item) =>
        overrideWrite({ kind: "object", ref: item.ref }, item)
      ),
      ...chunk.overrides.linkUpserts.map((item) =>
        overrideWrite({ kind: "link", ref: item.ref }, item)
      ),
    ]
    const inserts = upserts.filter((item) => item.expectedLastCommitId === null)
    if (inserts.length > 0) {
      const rows = await this.sql<{ readonly entity_kind: "object" | "link" }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, inserts)}::jsonb)
        )
        INSERT INTO ontology_overrides (
          project_id, entity_kind, entity_key, entity_sort_key,
          object_type_id, primary_id, source_type_id, source_primary_id,
          link_id, target_type_id, target_primary_id,
          value, last_commit_id, updated_at
        )
        SELECT ${projectId}, value->>'kind', value->'entityKey', value->>'sortKey',
          value->>'objectTypeId', value->>'primaryId', value->>'sourceTypeId',
          value->>'sourcePrimaryId', value->>'linkId', value->>'targetTypeId',
          value->>'targetPrimaryId', value->'value', value->>'lastCommitId',
          (value->>'updatedAt')::timestamptz
        FROM staged
        ON CONFLICT DO NOTHING
        RETURNING entity_kind
      `
      if (rows.length !== inserts.length) throw overrideConflict(inserts[0]!.kind)
    }

    const updates = upserts.filter((item) => item.expectedLastCommitId !== null)
    if (updates.length > 0) {
      const rows = await this.sql<{ readonly entity_kind: "object" | "link" }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, updates)}::jsonb)
        )
        UPDATE ontology_overrides AS overrides
        SET value = staged.value->'value', last_commit_id = staged.value->>'lastCommitId',
          updated_at = (staged.value->>'updatedAt')::timestamptz
        FROM staged
        WHERE overrides.project_id = ${projectId}
          AND overrides.entity_kind = staged.value->>'kind'
          AND overrides.entity_key = staged.value->'entityKey'
          AND overrides.last_commit_id = staged.value->>'expectedLastCommitId'
        RETURNING overrides.entity_kind
      `
      if (rows.length !== updates.length) throw overrideConflict(updates[0]!.kind)
    }

    const deletes = [
      ...chunk.overrides.objectDeletes.map((item) => ({
        kind: "object" as const,
        entityKey: JSON.parse(objectRefKey(item.ref)) as unknown,
        expectedLastCommitId: item.expectedLastCommitId,
      })),
      ...chunk.overrides.linkDeletes.map((item) => ({
        kind: "link" as const,
        entityKey: JSON.parse(linkRefKey(item.ref)) as unknown,
        expectedLastCommitId: item.expectedLastCommitId,
      })),
    ]
    if (deletes.length > 0) {
      const rows = await this.sql<{ readonly entity_kind: "object" | "link" }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, deletes)}::jsonb)
        )
        DELETE FROM ontology_overrides AS overrides USING staged
        WHERE overrides.project_id = ${projectId}
          AND overrides.entity_kind = staged.value->>'kind'
          AND overrides.entity_key = staged.value->'entityKey'
          AND overrides.last_commit_id = staged.value->>'expectedLastCommitId'
        RETURNING overrides.entity_kind
      `
      if (rows.length !== deletes.length) throw overrideConflict(deletes[0]!.kind)
    }
  }

  private async applyEffective(projectId: string, chunk: MaterializationPlanChunk): Promise<void> {
    const linkDeletes = chunk.effective.linkDeletes.map((item) => ({
      sourceTypeId: item.ref.source.objectTypeId,
      sourceId: item.ref.source.primaryId,
      linkId: item.ref.linkId,
      targetTypeId: item.ref.target.objectTypeId,
      targetId: item.ref.target.primaryId,
      expectedLastCommitId: item.expected.lastCommitId,
    }))
    if (linkDeletes.length > 0) {
      const rows = await this.sql<{ readonly source_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, linkDeletes)}::jsonb)
        )
        DELETE FROM links AS effective USING staged
        WHERE effective.project_id = ${projectId}
          AND effective.source_type_id = staged.value->>'sourceTypeId'
          AND effective.source_id = staged.value->>'sourceId'
          AND effective.link_id = staged.value->>'linkId'
          AND effective.target_type_id = staged.value->>'targetTypeId'
          AND effective.target_id = staged.value->>'targetId'
          AND effective.last_commit_id = staged.value->>'expectedLastCommitId'
        RETURNING effective.source_type_id
      `
      if (rows.length !== linkDeletes.length) throw effectiveLinkConflict(linkDeletes[0]!)
    }

    const objectDeletes = chunk.effective.objectDeletes.map((item) => ({
      objectTypeId: item.ref.objectTypeId,
      primaryId: item.ref.primaryId,
      expectedVersion: item.expected.version,
      expectedLastCommitId: item.expected.lastCommitId,
    }))
    if (objectDeletes.length > 0) {
      const rows = await this.sql<{ readonly object_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, objectDeletes)}::jsonb)
        )
        DELETE FROM objects AS effective USING staged
        WHERE effective.project_id = ${projectId}
          AND effective.object_type_id = staged.value->>'objectTypeId'
          AND effective.primary_id = staged.value->>'primaryId'
          AND effective.version = (staged.value->>'expectedVersion')::integer
          AND effective.last_commit_id = staged.value->>'expectedLastCommitId'
        RETURNING effective.object_type_id
      `
      if (rows.length !== objectDeletes.length) throw effectiveObjectConflict(objectDeletes[0]!)
    }

    await this.applyObjects(projectId, chunk.effective.objectUpserts)
    await this.applyLinks(projectId, chunk.effective.linkUpserts)
  }

  private async applyObjects(
    projectId: string,
    items: MaterializationPlanChunk["effective"]["objectUpserts"]
  ): Promise<void> {
    const payload = items.map(({ row, expected }) => ({
      objectTypeId: row.ref.objectTypeId,
      primaryId: row.ref.primaryId,
      properties: row.properties,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      lastCommitId: row.lastCommitId,
      expectedExists: expected.exists,
      expectedVersion: expected.exists ? expected.version : null,
      expectedLastCommitId: expected.exists ? expected.lastCommitId : null,
    }))
    const inserts = payload.filter((item) => !item.expectedExists)
    if (inserts.length > 0) {
      const rows = await this.sql<{ readonly object_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, inserts)}::jsonb)
        )
        INSERT INTO objects (
          project_id, object_type_id, primary_id, properties, created_at,
          updated_at, version, source_event_id, last_commit_id
        )
        SELECT ${projectId}, value->>'objectTypeId', value->>'primaryId',
          value->'properties', (value->>'createdAt')::timestamptz,
          (value->>'updatedAt')::timestamptz, (value->>'version')::integer,
          NULL, value->>'lastCommitId'
        FROM staged
        ON CONFLICT DO NOTHING
        RETURNING object_type_id
      `
      if (rows.length !== inserts.length) {
        throw effectiveConflict(`Expected object ${objectIdentityKey(inserts[0]!)} to be absent.`)
      }
    }

    const updates = payload.filter((item) => item.expectedExists)
    if (updates.length > 0) {
      const rows = await this.sql<{ readonly object_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, updates)}::jsonb)
        )
        UPDATE objects AS effective
        SET properties = staged.value->'properties',
          created_at = (staged.value->>'createdAt')::timestamptz,
          updated_at = (staged.value->>'updatedAt')::timestamptz,
          version = (staged.value->>'version')::integer,
          source_event_id = NULL, last_commit_id = staged.value->>'lastCommitId'
        FROM staged
        WHERE effective.project_id = ${projectId}
          AND effective.object_type_id = staged.value->>'objectTypeId'
          AND effective.primary_id = staged.value->>'primaryId'
          AND effective.version = (staged.value->>'expectedVersion')::integer
          AND effective.last_commit_id = staged.value->>'expectedLastCommitId'
        RETURNING effective.object_type_id
      `
      if (rows.length !== updates.length) throw effectiveObjectConflict(updates[0]!)
    }
  }

  private async applyLinks(
    projectId: string,
    items: MaterializationPlanChunk["effective"]["linkUpserts"]
  ): Promise<void> {
    const payload = items.map(({ row, expected }) => ({
      sourceTypeId: row.ref.source.objectTypeId,
      sourceId: row.ref.source.primaryId,
      linkId: row.ref.linkId,
      targetTypeId: row.ref.target.objectTypeId,
      targetId: row.ref.target.primaryId,
      ...(row.properties === undefined ? {} : { properties: row.properties }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastCommitId: row.lastCommitId,
      expectedExists: expected.exists,
      expectedLastCommitId: expected.exists ? expected.lastCommitId : null,
    }))
    const inserts = payload.filter((item) => !item.expectedExists)
    if (inserts.length > 0) {
      const rows = await this.sql<{ readonly source_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, inserts)}::jsonb)
        )
        INSERT INTO links (
          project_id, source_type_id, source_id, link_id, target_type_id, target_id,
          properties, created_at, updated_at, source_event_id, last_commit_id
        )
        SELECT ${projectId}, value->>'sourceTypeId', value->>'sourceId', value->>'linkId',
          value->>'targetTypeId', value->>'targetId',
          CASE WHEN value ? 'properties' THEN value->'properties' ELSE NULL END,
          (value->>'createdAt')::timestamptz, (value->>'updatedAt')::timestamptz,
          NULL, value->>'lastCommitId'
        FROM staged
        ON CONFLICT DO NOTHING
        RETURNING source_type_id
      `
      if (rows.length !== inserts.length) {
        throw effectiveConflict(`Expected link ${linkIdentityKey(inserts[0]!)} to be absent.`)
      }
    }

    const updates = payload.filter((item) => item.expectedExists)
    if (updates.length > 0) {
      const rows = await this.sql<{ readonly source_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, updates)}::jsonb)
        )
        UPDATE links AS effective
        SET properties = CASE
            WHEN staged.value ? 'properties' THEN staged.value->'properties'
            ELSE NULL
          END,
          created_at = (staged.value->>'createdAt')::timestamptz,
          updated_at = (staged.value->>'updatedAt')::timestamptz,
          source_event_id = NULL, last_commit_id = staged.value->>'lastCommitId'
        FROM staged
        WHERE effective.project_id = ${projectId}
          AND effective.source_type_id = staged.value->>'sourceTypeId'
          AND effective.source_id = staged.value->>'sourceId'
          AND effective.link_id = staged.value->>'linkId'
          AND effective.target_type_id = staged.value->>'targetTypeId'
          AND effective.target_id = staged.value->>'targetId'
          AND effective.last_commit_id = staged.value->>'expectedLastCommitId'
        RETURNING effective.source_type_id
      `
      if (rows.length !== updates.length) throw effectiveLinkConflict(updates[0]!)
    }
  }

  private async applyTimeseries(projectId: string, chunk: MaterializationPlanChunk): Promise<void> {
    const payload = chunk.timeseries.pointUpserts.map(({ point, expected }) => ({
      objectTypeId: point.series.object.objectTypeId,
      objectId: point.series.object.primaryId,
      propertyId: point.series.propertyId,
      value: point.value,
      unit: point.unit ?? null,
      at: point.at,
      lastCommitId: point.lastCommitId,
      expectedLastCommitId: expected.lastCommitId,
    }))
    const inserts = payload.filter((item) => item.expectedLastCommitId === null)
    if (inserts.length > 0) {
      const rows = await this.sql<{ readonly object_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, inserts)}::jsonb)
        ), written AS (
          INSERT INTO timeseries (
            project_id, object_type_id, object_id, property_id,
            value, unit, at, source_event_id, last_commit_id
          )
          SELECT ${projectId}, value->>'objectTypeId', value->>'objectId',
            value->>'propertyId', value->'value', value->>'unit',
            (value->>'at')::timestamptz, NULL, value->>'lastCommitId'
          FROM staged
          ON CONFLICT DO NOTHING
          RETURNING *
        ), latest AS (
          INSERT INTO timeseries_latest (
            project_id, object_type_id, object_id, property_id,
            value, unit, at, source_event_id, last_commit_id
          )
          SELECT project_id, object_type_id, object_id, property_id,
            value, unit, at, source_event_id, last_commit_id
          FROM written
          ON CONFLICT (project_id, object_type_id, object_id, property_id)
          DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit, at = EXCLUDED.at,
            source_event_id = EXCLUDED.source_event_id,
            last_commit_id = EXCLUDED.last_commit_id
          WHERE EXCLUDED.at >= timeseries_latest.at
          RETURNING object_type_id
        )
        SELECT object_type_id, (SELECT COUNT(*) FROM latest) AS latest_count FROM written
      `
      if (rows.length !== inserts.length) throw pointConflict(inserts[0]!)
    }

    const updates = payload.filter((item) => item.expectedLastCommitId !== null)
    if (updates.length > 0) {
      const rows = await this.sql<{ readonly object_type_id: string }[]>`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, updates)}::jsonb)
        ), written AS (
          UPDATE timeseries AS points
          SET value = staged.value->'value', unit = staged.value->>'unit',
            source_event_id = NULL, last_commit_id = staged.value->>'lastCommitId'
          FROM staged
          WHERE points.project_id = ${projectId}
            AND points.object_type_id = staged.value->>'objectTypeId'
            AND points.object_id = staged.value->>'objectId'
            AND points.property_id = staged.value->>'propertyId'
            AND points.at = (staged.value->>'at')::timestamptz
            AND points.last_commit_id = staged.value->>'expectedLastCommitId'
          RETURNING points.*
        ), latest AS (
          INSERT INTO timeseries_latest (
            project_id, object_type_id, object_id, property_id,
            value, unit, at, source_event_id, last_commit_id
          )
          SELECT project_id, object_type_id, object_id, property_id,
            value, unit, at, source_event_id, last_commit_id
          FROM written
          ON CONFLICT (project_id, object_type_id, object_id, property_id)
          DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit, at = EXCLUDED.at,
            source_event_id = EXCLUDED.source_event_id,
            last_commit_id = EXCLUDED.last_commit_id
          WHERE EXCLUDED.at >= timeseries_latest.at
          RETURNING object_type_id
        )
        SELECT object_type_id, (SELECT COUNT(*) FROM latest) AS latest_count FROM written
      `
      if (rows.length !== updates.length) throw pointConflict(updates[0]!)
    }
  }

  private async applyOutbox(
    projectId: string,
    commitId: string,
    chunk: MaterializationPlanChunk
  ): Promise<void> {
    if (chunk.outbox.length === 0) return
    const payload = chunk.outbox.map((item) => {
      assertTimestamp(item.availableAt, "Outbox availableAt")
      assertTimestamp(item.createdAt, "Outbox createdAt")
      return {
        id: item.envelope.id,
        commitOrdinal: item.envelope.commitOrdinal,
        envelope: item.envelope,
        availableAt: item.availableAt,
        createdAt: item.createdAt,
      }
    })
    const rows = await this.sql<{ readonly id: string }[]>`
      WITH staged AS (
        SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, payload)}::jsonb)
      )
      INSERT INTO ontology_outbox (
        project_id, id, commit_id, commit_ordinal, envelope,
        available_at, attempts, lease_id, lease_expires_at,
        published_at, last_error, created_at
      )
      SELECT ${projectId}, value->>'id', ${commitId},
        (value->>'commitOrdinal')::bigint, value->'envelope',
        (value->>'availableAt')::timestamptz, 0, NULL, NULL, NULL, NULL,
        (value->>'createdAt')::timestamptz
      FROM staged
      ON CONFLICT DO NOTHING
      RETURNING id
    `
    if (rows.length !== payload.length) {
      const inserted = new Set(rows.map((row) => row.id))
      const duplicate = payload.find((item) => !inserted.has(item.id)) ?? payload[0]!
      throw effectiveConflict(`Duplicate outbox event '${duplicate.id}'.`)
    }
  }
}

function overrideWrite(
  entity: OverrideEntity,
  item: {
    readonly value: unknown
    readonly lastCommitId: string
    readonly updatedAt: string
    readonly expectedLastCommitId: string | null
  }
) {
  const key = entity.kind === "object" ? objectRefKey(entity.ref) : linkRefKey(entity.ref)
  const columns = overrideColumns(entity)
  return {
    kind: entity.kind,
    entityKey: JSON.parse(key) as unknown,
    ...columns,
    value: item.value,
    lastCommitId: item.lastCommitId,
    updatedAt: item.updatedAt,
    expectedLastCommitId: item.expectedLastCommitId,
  }
}

function overrideConflict(kind: "object" | "link"): MaterializationConflictError {
  return effectiveConflict(`Expected ${kind} override changed.`)
}

function objectIdentityKey(item: {
  readonly objectTypeId: string
  readonly primaryId: string
}): string {
  return objectRefKey({ objectTypeId: item.objectTypeId, primaryId: item.primaryId })
}

function linkIdentityKey(item: {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
}): string {
  return linkRefKey({
    source: { objectTypeId: item.sourceTypeId, primaryId: item.sourceId },
    linkId: item.linkId,
    target: { objectTypeId: item.targetTypeId, primaryId: item.targetId },
  })
}

function effectiveObjectConflict(item: {
  readonly objectTypeId: string
  readonly primaryId: string
}): MaterializationConflictError {
  return effectiveConflict(`Expected object ${objectIdentityKey(item)} changed.`)
}

function effectiveLinkConflict(item: {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
}): MaterializationConflictError {
  return effectiveConflict(`Expected link ${linkIdentityKey(item)} changed.`)
}

function pointConflict(item: {
  readonly objectTypeId: string
  readonly objectId: string
  readonly propertyId: string
  readonly at: string
}): MaterializationConflictError {
  return new MaterializationConflictError(
    "timeseries-point",
    `Telemetry point ${telemetryPointKey(
      {
        object: { objectTypeId: item.objectTypeId, primaryId: item.objectId },
        propertyId: item.propertyId,
      },
      item.at
    )} changed.`
  )
}
