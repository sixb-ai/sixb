import {
  linkRefKey,
  MaterializationConflictError,
  type OntologyLinkRef,
  type OntologyObjectRef,
  objectRefKey,
  type TelemetrySeriesRef,
  telemetryPointKey,
} from "@sixb/core/internal/materialization"
import {
  canonicalJson,
  effectiveConflict,
  materializationApplyPhase,
  materializationPlanKindRank,
} from "@sixb/core/internal/ontology-storage-provider"
import type { MaterializationPlanWorkItem } from "@sixb/core/storage"
import type postgres from "postgres"
import type { SQL, SQLClient } from "../pg-client"

export interface PgStagedPlanTarget {
  /** The work table and the id its rows carry: a session's temp table, or a durable plan. */
  readonly workTable: string
  readonly workId: string
  readonly projectId: string
  readonly commitId: string
  readonly committedAt: string
}

export interface PgAppliedPlan {
  readonly objectWrites: number
  readonly linkWrites: number
  readonly eventCount: number
}

interface WriteCounts {
  readonly staged: number | string
  readonly written: number | string
}

type Fragment = ReturnType<SQL["unsafe"]>
type Query = postgres.PendingQuery<postgres.Row[]>

/**
 * Applies a session's staged plan where it is stored: each statement reads one item kind from the
 * work table and writes it set-based, so planned rows never travel back through the client.
 *
 * Every write still checks the revision its plan expected. A statement that writes fewer rows than
 * it staged is a conflict; only then does a second, indexed query find the entity to name, so the
 * normal path never correlates the written rows back to the staged ones.
 */
export class PgMaterializationWriter {
  constructor(private readonly sql: SQLClient) {}

  async applyStaged(target: PgStagedPlanTarget): Promise<PgAppliedPlan> {
    await this.applyObjectOverrides(target)
    await this.applyLinkOverrides(target)
    await this.applyPoints(target)
    let linkWrites = await this.deleteLinks(target)
    let objectWrites = await this.deleteObjects(target)
    objectWrites += await this.upsertObjects(target)
    linkWrites += await this.upsertLinks(target)
    const eventCount = await this.writeOutbox(target)
    await this.writeTouches(target)
    return { objectWrites, linkWrites, eventCount }
  }

  /** The staged values of one plan item kind, as `value`. */
  private staged(target: PgStagedPlanTarget, kind: MaterializationPlanWorkItem["kind"]) {
    return this.sql`
      SELECT payload->'item'->'value' AS value
      FROM ${this.sql(target.workTable)}
      WHERE work_id = ${target.workId} AND lane = 'apply'
        AND major_order = ${materializationApplyPhase(kind)}
        AND minor_order = ${materializationPlanKindRank(kind)}
    `
  }

  private async applyObjectOverrides(target: PgStagedPlanTarget): Promise<void> {
    const { projectId } = target
    const inserts = this.sql`
      SELECT value FROM (${this.staged(target, "object-override-upsert")}) AS staged
      WHERE value->>'expectedLastCommitId' IS NULL
    `
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${inserts}), written AS (
          INSERT INTO ontology_object_overrides (
            project_id, object_type_id, primary_id, value, edited_at, last_commit_id, updated_at
          )
          SELECT ${projectId}, value->'ref'->>'objectTypeId', value->'ref'->>'primaryId',
            value->'value', value->'editedAt', value->>'lastCommitId',
            (value->>'updatedAt')::timestamptz
          FROM candidates
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        throw objectOverrideConflict()
      }
    )
    const updates = this.sql`
      SELECT value FROM (${this.staged(target, "object-override-upsert")}) AS staged
      WHERE value->>'expectedLastCommitId' IS NOT NULL
    `
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${updates}), written AS (
          UPDATE ontology_object_overrides AS stored
          SET value = candidates.value->'value', edited_at = candidates.value->'editedAt',
            last_commit_id = candidates.value->>'lastCommitId',
            updated_at = (candidates.value->>'updatedAt')::timestamptz
          FROM candidates
          WHERE stored.project_id = ${projectId} AND ${this.matches("object", "value->'ref'")}
            AND stored.last_commit_id = candidates.value->>'expectedLastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        throw objectOverrideConflict()
      }
    )
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${this.staged(target, "object-override-delete")}), written AS (
          DELETE FROM ontology_object_overrides AS stored USING candidates
          WHERE stored.project_id = ${projectId} AND ${this.matches("object", "value->'ref'")}
            AND stored.last_commit_id = candidates.value->>'expectedLastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        throw objectOverrideConflict()
      }
    )
  }

  private async applyLinkOverrides(target: PgStagedPlanTarget): Promise<void> {
    const { projectId, commitId } = target
    // An edge is keyed by its whole link ref and targets it; a slot is keyed by its scope and
    // targets the member its value names.
    const identified = (
      edges: MaterializationPlanWorkItem["kind"],
      slots: MaterializationPlanWorkItem["kind"]
    ) => this.sql`
      SELECT 'edge' AS identity_kind,
        jsonb_build_array(
          value->'ref'->'source'->>'objectTypeId', value->'ref'->'source'->>'primaryId',
          value->'ref'->>'linkId',
          value->'ref'->'target'->>'objectTypeId', value->'ref'->'target'->>'primaryId'
        ) AS identity_key,
        value->'ref'->'target' AS target, value
      FROM (${this.staged(target, edges)}) AS edges
      UNION ALL
      SELECT 'slot',
        jsonb_build_array(
          value->'ref'->'source'->>'objectTypeId', value->'ref'->'source'->>'primaryId',
          value->'ref'->>'linkId'
        ),
        value->'value'->'target', value
      FROM (${this.staged(target, slots)}) AS slots
    `
    const upserts = identified("link-override-upsert", "link-slot-override-upsert")
    const writes = (inserts: boolean) => this.sql`
      SELECT * FROM (${upserts}) AS upserts
      WHERE (value->>'expectedLastCommitId' IS NULL) = ${inserts}
    `
    const deletes = identified("link-override-delete", "link-slot-override-delete")
    const stored = this.sql`
      SELECT 1 FROM ontology_link_overrides AS stored
      WHERE stored.project_id = ${projectId}
        AND stored.identity_kind = candidates.identity_kind
        AND stored.identity_key = candidates.identity_key
    `
    const firstUnwritten = (source: typeof upserts) => async () => {
      const [row] = await this.sql<{ readonly identity_kind: string }[]>`
        SELECT identity_kind FROM (${source}) AS candidates
        WHERE NOT EXISTS (${stored} AND stored.last_commit_id = ${commitId})
        LIMIT 1
      `
      throw linkOverrideConflict(row?.identity_kind)
    }
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${writes(true)}), written AS (
          INSERT INTO ontology_link_overrides (
            project_id, identity_kind, identity_key, source_type_id, source_primary_id, link_id,
            target_type_id, target_primary_id, value, last_commit_id, updated_at
          )
          SELECT ${projectId}, identity_kind, identity_key,
            value->'ref'->'source'->>'objectTypeId', value->'ref'->'source'->>'primaryId',
            value->'ref'->>'linkId', target->>'objectTypeId', target->>'primaryId',
            value->'value', value->>'lastCommitId', (value->>'updatedAt')::timestamptz
          FROM candidates
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      firstUnwritten(writes(true))
    )
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${writes(false)}), written AS (
          UPDATE ontology_link_overrides AS stored
          SET target_type_id = candidates.target->>'objectTypeId',
            target_primary_id = candidates.target->>'primaryId',
            value = candidates.value->'value',
            last_commit_id = candidates.value->>'lastCommitId',
            updated_at = (candidates.value->>'updatedAt')::timestamptz
          FROM candidates
          WHERE stored.project_id = ${projectId}
            AND stored.identity_kind = candidates.identity_kind
            AND stored.identity_key = candidates.identity_key
            AND stored.last_commit_id = candidates.value->>'expectedLastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      firstUnwritten(writes(false))
    )
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${deletes}), written AS (
          DELETE FROM ontology_link_overrides AS stored USING candidates
          WHERE stored.project_id = ${projectId}
            AND stored.identity_kind = candidates.identity_kind
            AND stored.identity_key = candidates.identity_key
            AND stored.last_commit_id = candidates.value->>'expectedLastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        const [row] = await this.sql<{ readonly identity_kind: string }[]>`
          SELECT identity_kind FROM (${deletes}) AS candidates WHERE EXISTS (${stored}) LIMIT 1
        `
        throw linkOverrideConflict(row?.identity_kind)
      }
    )
  }

  private async applyPoints(target: PgStagedPlanTarget): Promise<void> {
    const { projectId, commitId } = target
    const points = (inserts: boolean) => this.sql`
      SELECT value->'point'->'series'->'object'->>'objectTypeId' AS object_type_id,
        value->'point'->'series'->'object'->>'primaryId' AS object_id,
        value->'point'->'series'->>'propertyId' AS property_id,
        value->'point'->'value' AS value, value->'point'->>'unit' AS unit,
        (value->'point'->>'at')::timestamptz AS at,
        value->'point'->>'lastCommitId' AS last_commit_id,
        value->'expected'->>'lastCommitId' AS expected_last_commit_id,
        value->'point' AS point
      FROM (${this.staged(target, "point-upsert")}) AS staged
      WHERE (value->'expected'->>'lastCommitId' IS NULL) = ${inserts}
    `
    // Both statements keep `timeseries_latest` on the newest point of each series.
    const latest = this.sql`
      latest_candidates AS (
        SELECT DISTINCT ON (project_id, object_type_id, object_id, property_id)
          project_id, object_type_id, object_id, property_id, value, unit, at, last_commit_id
        FROM written
        ORDER BY project_id, object_type_id, object_id, property_id, at DESC
      ), latest AS (
        INSERT INTO timeseries_latest (
          project_id, object_type_id, object_id, property_id, value, unit, at, last_commit_id
        )
        SELECT project_id, object_type_id, object_id, property_id, value, unit, at,
          last_commit_id
        FROM latest_candidates
        ON CONFLICT (project_id, object_type_id, object_id, property_id)
        DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit, at = EXCLUDED.at,
          last_commit_id = EXCLUDED.last_commit_id
        WHERE EXCLUDED.at >= timeseries_latest.at
      )
    `
    const firstUnwritten = (inserts: boolean) => async () => {
      const [row] = await this.sql<{ readonly point: unknown }[]>`
        SELECT point FROM (${points(inserts)}) AS candidates
        WHERE NOT EXISTS (
          SELECT 1 FROM timeseries AS stored
          WHERE stored.project_id = ${projectId}
            AND stored.object_type_id = candidates.object_type_id
            AND stored.object_id = candidates.object_id
            AND stored.property_id = candidates.property_id
            AND stored.at = candidates.at
            AND stored.last_commit_id = ${commitId}
        )
        LIMIT 1
      `
      throw pointConflict(row?.point)
    }
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${points(true)}), written AS (
          INSERT INTO timeseries (
            project_id, object_type_id, object_id, property_id, value, unit, at, last_commit_id
          )
          SELECT ${projectId}, object_type_id, object_id, property_id, value, unit, at,
            last_commit_id
          FROM candidates
          ON CONFLICT DO NOTHING
          RETURNING *
        ), ${latest}
        ${counts(this.sql)}
      `,
      firstUnwritten(true)
    )
    await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${points(false)}), written AS (
          UPDATE timeseries AS stored
          SET value = candidates.value, unit = candidates.unit,
            last_commit_id = candidates.last_commit_id
          FROM candidates
          WHERE stored.project_id = ${projectId}
            AND stored.object_type_id = candidates.object_type_id
            AND stored.object_id = candidates.object_id
            AND stored.property_id = candidates.property_id
            AND stored.at = candidates.at
            AND stored.last_commit_id = candidates.expected_last_commit_id
          RETURNING stored.*
        ), ${latest}
        ${counts(this.sql)}
      `,
      firstUnwritten(false)
    )
  }

  private async deleteLinks(target: PgStagedPlanTarget): Promise<number> {
    const candidates = this.staged(target, "link-delete")
    return this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${candidates}), written AS (
          DELETE FROM links AS stored USING candidates
          WHERE stored.project_id = ${target.projectId} AND ${this.matches("link", "value->'ref'")}
            AND stored.last_commit_id = candidates.value->'expected'->>'lastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        const ref = await this.firstConflict(target, candidates, "link", "value->'ref'", "delete")
        throw effectiveLinkConflict(ref as OntologyLinkRef | undefined)
      }
    )
  }

  private async deleteObjects(target: PgStagedPlanTarget): Promise<number> {
    const candidates = this.staged(target, "object-delete")
    return this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${candidates}), written AS (
          DELETE FROM objects AS stored USING candidates
          WHERE stored.project_id = ${target.projectId} AND ${this.matches("object", "value->'ref'")}
            AND stored.version = (candidates.value->'expected'->>'version')::integer
            AND stored.last_commit_id = candidates.value->'expected'->>'lastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        const ref = await this.firstConflict(target, candidates, "object", "value->'ref'", "delete")
        throw effectiveObjectConflict(ref as OntologyObjectRef | undefined)
      }
    )
  }

  private async upsertObjects(target: PgStagedPlanTarget): Promise<number> {
    const { projectId } = target
    const subset = (exists: boolean) => this.sql`
      SELECT value FROM (${this.staged(target, "object-upsert")}) AS staged
      WHERE ((value->'expected'->>'exists')::boolean IS TRUE) = ${exists}
    `
    const inserted = await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${subset(false)}), written AS (
          INSERT INTO objects (
            project_id, object_type_id, primary_id, properties, created_at, updated_at,
            version, last_commit_id
          )
          SELECT ${projectId}, value->'row'->'ref'->>'objectTypeId',
            value->'row'->'ref'->>'primaryId', value->'row'->'properties',
            (value->'row'->>'createdAt')::timestamptz, (value->'row'->>'updatedAt')::timestamptz,
            (value->'row'->>'version')::integer, value->'row'->>'lastCommitId'
          FROM candidates
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        const ref = await this.firstConflict(
          target,
          subset(false),
          "object",
          "value->'row'->'ref'",
          "insert"
        )
        throw effectiveConflict(
          `Expected ${objectLabel(ref as OntologyObjectRef | undefined)} to be absent.`
        )
      }
    )
    const updated = await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${subset(true)}), written AS (
          UPDATE objects AS stored
          SET properties = candidates.value->'row'->'properties',
            created_at = (candidates.value->'row'->>'createdAt')::timestamptz,
            updated_at = (candidates.value->'row'->>'updatedAt')::timestamptz,
            version = (candidates.value->'row'->>'version')::integer,
            last_commit_id = candidates.value->'row'->>'lastCommitId'
          FROM candidates
          WHERE stored.project_id = ${projectId}
            AND ${this.matches("object", "value->'row'->'ref'")}
            AND stored.version = (candidates.value->'expected'->>'version')::integer
            AND stored.last_commit_id = candidates.value->'expected'->>'lastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        const ref = await this.firstConflict(
          target,
          subset(true),
          "object",
          "value->'row'->'ref'",
          "update"
        )
        throw effectiveObjectConflict(ref as OntologyObjectRef | undefined)
      }
    )
    return inserted + updated
  }

  private async upsertLinks(target: PgStagedPlanTarget): Promise<number> {
    const { projectId } = target
    const subset = (exists: boolean) => this.sql`
      SELECT value FROM (${this.staged(target, "link-upsert")}) AS staged
      WHERE ((value->'expected'->>'exists')::boolean IS TRUE) = ${exists}
    `
    const inserted = await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${subset(false)}), written AS (
          INSERT INTO links (
            project_id, source_type_id, source_id, link_id, target_type_id, target_id,
            properties, created_at, updated_at, last_commit_id
          )
          SELECT ${projectId}, value->'row'->'ref'->'source'->>'objectTypeId',
            value->'row'->'ref'->'source'->>'primaryId', value->'row'->'ref'->>'linkId',
            value->'row'->'ref'->'target'->>'objectTypeId',
            value->'row'->'ref'->'target'->>'primaryId', value->'row'->'properties',
            (value->'row'->>'createdAt')::timestamptz, (value->'row'->>'updatedAt')::timestamptz,
            value->'row'->>'lastCommitId'
          FROM candidates
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        const ref = await this.firstConflict(
          target,
          subset(false),
          "link",
          "value->'row'->'ref'",
          "insert"
        )
        throw effectiveConflict(
          `Expected ${linkLabel(ref as OntologyLinkRef | undefined)} to be absent.`
        )
      }
    )
    const updated = await this.write(
      this.sql<WriteCounts[]>`
        WITH candidates AS (${subset(true)}), written AS (
          UPDATE links AS stored
          SET properties = candidates.value->'row'->'properties',
            created_at = (candidates.value->'row'->>'createdAt')::timestamptz,
            updated_at = (candidates.value->'row'->>'updatedAt')::timestamptz,
            last_commit_id = candidates.value->'row'->>'lastCommitId'
          FROM candidates
          WHERE stored.project_id = ${projectId}
            AND ${this.matches("link", "value->'row'->'ref'")}
            AND stored.last_commit_id = candidates.value->'expected'->>'lastCommitId'
          RETURNING 1
        )
        ${counts(this.sql)}
      `,
      async () => {
        const ref = await this.firstConflict(
          target,
          subset(true),
          "link",
          "value->'row'->'ref'",
          "update"
        )
        throw effectiveLinkConflict(ref as OntologyLinkRef | undefined)
      }
    )
    return inserted + updated
  }

  /**
   * Writes the staged event drafts in canonical order. Event ids hash the canonical JSON of
   * `[projectId, commitId, ordinal]`; the provider-fixed prefix is rendered here, the ordinal by
   * PostgreSQL, so the outbox matches `createEventId` without one id crossing the wire.
   */
  private async writeOutbox(target: PgStagedPlanTarget): Promise<number> {
    const prefix = `${canonicalJson([target.projectId, target.commitId]).slice(0, -1)},`
    const [row] = await this.sql<WriteCounts[]>`
      WITH candidates AS (
        SELECT payload->'draft' AS draft,
          row_number() OVER (
            ORDER BY major_order, minor_order, sort_one, sort_two, record_key
          ) - 1 AS ordinal
        FROM ${this.sql(target.workTable)}
        WHERE work_id = ${target.workId} AND lane = 'event'
      ), identified AS (
        SELECT draft, ordinal,
          encode(sha256(convert_to(${prefix}::text || ordinal::text || ']', 'UTF8')), 'hex') AS id
        FROM candidates
      ), written AS (
        INSERT INTO ontology_outbox (
          project_id, id, commit_id, commit_ordinal, event,
          available_at, attempts, lease_id, lease_expires_at,
          published_at, last_failure, created_at
        )
        SELECT ${target.projectId}, id, ${target.commitId}, ordinal, draft,
          ${target.committedAt}::timestamptz, 0, NULL, NULL, NULL, NULL,
          ${target.committedAt}::timestamptz
        FROM identified
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      ${counts(this.sql)}
    `
    const staged = Number(row?.staged ?? 0)
    if (Number(row?.written ?? 0) !== staged) {
      throw effectiveConflict(`Outbox events of commit '${target.commitId}' already exist.`)
    }
    return staged
  }

  /**
   * Records the entities whose plan inputs this commit changed, once each, as the in-memory
   * `touchPlanItem` does: a replacement plan's refresh rechecks only those.
   */
  private async writeTouches(target: PgStagedPlanTarget): Promise<void> {
    await this.sql`
      INSERT INTO ontology_commit_touches (project_id, entity_kind, identity_key)
      SELECT DISTINCT ${target.projectId}, entity.kind,
        CASE entity.kind
          WHEN 'object' THEN
            concat('[', entity.ref->'objectTypeId', ',', entity.ref->'primaryId', ']')
          WHEN 'scope' THEN concat('[', entity.ref->'source'->'objectTypeId', ',',
            entity.ref->'source'->'primaryId', ',', entity.ref->'linkId', ']')
          ELSE concat('[', entity.ref->'source'->'objectTypeId', ',',
            entity.ref->'source'->'primaryId', ',', entity.ref->'linkId', ',',
            entity.ref->'target'->'objectTypeId', ',', entity.ref->'target'->'primaryId', ']')
        END
      FROM ${this.sql(target.workTable)} AS work
      CROSS JOIN LATERAL (
        SELECT CASE work.payload->'item'->>'kind'
            WHEN 'object-upsert' THEN 'object'
            WHEN 'object-delete' THEN 'object'
            WHEN 'object-override-upsert' THEN 'object'
            WHEN 'object-override-delete' THEN 'object'
            WHEN 'point-upsert' THEN 'object'
            WHEN 'link-upsert' THEN 'link'
            WHEN 'link-delete' THEN 'link'
            WHEN 'link-override-upsert' THEN 'link'
            WHEN 'link-override-delete' THEN 'link'
            WHEN 'link-slot-override-upsert' THEN 'scope'
            WHEN 'link-slot-override-delete' THEN 'scope'
          END AS kind,
          CASE work.payload->'item'->>'kind'
            WHEN 'object-upsert' THEN work.payload->'item'->'value'->'row'->'ref'
            WHEN 'link-upsert' THEN work.payload->'item'->'value'->'row'->'ref'
            WHEN 'point-upsert' THEN work.payload->'item'->'value'->'point'->'series'->'object'
            ELSE work.payload->'item'->'value'->'ref'
          END AS ref
      ) AS entity
      WHERE work.work_id = ${target.workId} AND work.lane = 'apply'
    `
  }

  private async write(
    statement: Promise<readonly WriteCounts[]>,
    conflict: () => Promise<never>
  ): Promise<number> {
    const [row] = await statement
    const written = Number(row?.written ?? 0)
    if (written !== Number(row?.staged ?? 0)) await conflict()
    return written
  }

  /** Matches a staged ref, at a static JSON path of `candidates.value`, to `stored`. */
  private matches(kind: "object" | "link", path: string): Fragment {
    const ref = `(candidates.${path})`
    return this.sql.unsafe(
      kind === "object"
        ? `stored.object_type_id = ${ref}->>'objectTypeId'
          AND stored.primary_id = ${ref}->>'primaryId'`
        : `stored.source_type_id = ${ref}->'source'->>'objectTypeId'
          AND stored.source_id = ${ref}->'source'->>'primaryId'
          AND stored.link_id = ${ref}->>'linkId'
          AND stored.target_type_id = ${ref}->'target'->>'objectTypeId'
          AND stored.target_id = ${ref}->'target'->>'primaryId'`
    )
  }

  /**
   * The ref of the first staged entity whose stored row tells why a write missed it: it still
   * exists after a delete, another commit wrote it before an insert, or an update left it without
   * this commit. None when no stored row tells, as for a delete whose row is already gone.
   */
  private async firstConflict(
    target: PgStagedPlanTarget,
    candidates: Query,
    kind: "object" | "link",
    path: string,
    missed: "delete" | "insert" | "update"
  ): Promise<unknown> {
    const table = kind === "object" ? "objects" : "links"
    const revision =
      missed === "insert"
        ? this.sql`AND stored.last_commit_id <> ${target.commitId}`
        : missed === "update"
          ? this.sql`AND stored.last_commit_id = ${target.commitId}`
          : this.sql``
    const stored = this.sql`
      EXISTS (
        SELECT 1 FROM ${this.sql(table)} AS stored
        WHERE stored.project_id = ${target.projectId} AND ${this.matches(kind, path)} ${revision}
      )
    `
    const [row] = await this.sql<{ readonly ref: unknown }[]>`
      SELECT ${this.sql.unsafe(`candidates.${path}`)} AS ref FROM (${candidates}) AS candidates
      WHERE ${missed === "update" ? this.sql`NOT` : this.sql``} ${stored}
      LIMIT 1
    `
    return row?.ref
  }
}

function counts(sql: SQLClient) {
  return sql`SELECT (SELECT COUNT(*) FROM candidates) AS staged,
    (SELECT COUNT(*) FROM written) AS written`
}

function objectOverrideConflict(): MaterializationConflictError {
  return effectiveConflict("Expected object override changed.")
}

function linkOverrideConflict(identityKind: string | undefined): MaterializationConflictError {
  return effectiveConflict(
    identityKind === "slot"
      ? "Expected link slot override changed."
      : "Expected link edge override changed."
  )
}

function effectiveObjectConflict(ref: OntologyObjectRef | undefined): MaterializationConflictError {
  return effectiveConflict(`Expected ${objectLabel(ref)} changed.`)
}

function effectiveLinkConflict(ref: OntologyLinkRef | undefined): MaterializationConflictError {
  return effectiveConflict(`Expected ${linkLabel(ref)} changed.`)
}

function objectLabel(ref: OntologyObjectRef | undefined): string {
  return ref ? `object ${objectRefKey(ref)}` : "object"
}

function linkLabel(ref: OntologyLinkRef | undefined): string {
  return ref ? `link ${linkRefKey(ref)}` : "link"
}

function pointConflict(point: unknown): MaterializationConflictError {
  const found = point as { readonly series: TelemetrySeriesRef; readonly at: string } | undefined
  return new MaterializationConflictError(
    "timeseries-point",
    found
      ? `Telemetry point ${telemetryPointKey(found.series, found.at)} changed.`
      : "Telemetry point changed."
  )
}
