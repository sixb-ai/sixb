import type { Database } from "bun:sqlite"
import {
  type EffectiveChangeCounts,
  MaterializationConflictError,
  MaterializationValidationError,
  type OntologyLinkRef,
  type OntologyObjectRef,
  objectRefKey,
} from "@sixb/core/internal/materialization"
import {
  assertNonblank,
  assertPageRows,
  assertPositiveInteger,
  assertReplacementPlanCommit,
  canonicalJson,
  duplicateMaterializationWork,
  invalidCorrelation,
  materializationWorkColumns,
  prepareReplacementIdentities,
  workUniquenessKey,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  MaterializationObjectExistence,
  OntologyCommitWrite,
  OntologyReplacementPlanStorage,
  OpenedReplacementPlan,
  OpenReplacementPlanInput,
  PurgeReplacementPlansInput,
  ReplacementPlanRef,
  ReplacementPlanStatePage,
  ReplacementPlanStatus,
  StageReplacementPlanInput,
  StreamReplacementPlanStateInput,
} from "@sixb/core/storage"
import { SqliteMaterializationStateReader } from "./materialization-state"
import {
  assertProjectionExecution,
  isSqliteConstraintError,
  parseJson,
  type SqliteOntologySourceRow,
  type SqliteRootOperation,
} from "./shared"
import { PUBLISHED, replacementSourceRows } from "./source-roots"

export const SQLITE_PLAN_WORK_TABLE = "ontology_replacement_plan_work"

/** The plan a session applies: its work rows carry the candidate's source version as `work_id`. */
export interface SqliteReplacementPlan {
  readonly versionId: number
  readonly projectionKind: "object" | "link"
}

interface PlanRow {
  readonly version_id: number
  readonly commit_id: string
  readonly committed_at: string
  readonly replaced_materialization_id: string | null
  readonly replaced_last_commit_id: string | null
  readonly watermark: number
}

interface IdentityRow {
  readonly identity_key: string
  readonly sort_key: string
  readonly diff_required: number
}

const IDENTITIES = "ontology_replacement_plan_identities"
/** An identity's planning order: its key's UTF-8 bytes, as `objectRefSortKey`/`linkRefSortKey`. */
const SORT_KEY = "LOWER(HEX(CAST(identity_key AS BLOB)))"

/**
 * The revision of an object identity: its effective row, its override and the latest point of each
 * telemetry property. `type` and `id` are SQL expressions; `$projectId` is bound.
 */
function objectRevision(type: string, id: string): string {
  const series = (alias: string) =>
    `${alias}.project_id = $projectId AND ${alias}.object_type_id = ${type} AND ${alias}.object_id = ${id}`
  // One seek per property for its next name and one for its latest point: never the history.
  return `json_array(
    (SELECT json_array(version, last_commit_id) FROM objects
      WHERE project_id = $projectId AND object_type_id = ${type} AND primary_id = ${id}),
    (SELECT last_commit_id FROM ontology_object_overrides
      WHERE project_id = $projectId AND object_type_id = ${type} AND primary_id = ${id}),
    (WITH RECURSIVE properties(property_id) AS (
      SELECT MIN(first.property_id) FROM timeseries AS first WHERE ${series("first")}
      UNION ALL
      SELECT (SELECT MIN(next.property_id) FROM timeseries AS next
        WHERE ${series("next")} AND next.property_id > properties.property_id)
      FROM properties WHERE properties.property_id IS NOT NULL
    )
    SELECT json_group_array(json((
      SELECT json_array(points.property_id, points.at, points.last_commit_id)
      FROM timeseries AS points
      WHERE ${series("points")} AND points.property_id = properties.property_id
      ORDER BY points.at DESC LIMIT 1
    ))) FROM properties WHERE properties.property_id IS NOT NULL)
  )`
}

/**
 * The revision of a link endpoint, which a link plan reads only for its existence. One this plan
 * decides exists as planned, which follows its whole object revision; any other exists as it is.
 * `$versionId` is bound.
 */
function endpointRevision(type: string, id: string): string {
  return `CASE WHEN EXISTS (
      SELECT 1 FROM ${IDENTITIES} AS endpoint
      WHERE endpoint.version_id = $versionId AND endpoint.entity_kind = 'object'
        AND endpoint.identity_key = json_array(${type}, ${id})
    ) THEN ${objectRevision(type, id)}
    ELSE json(CASE WHEN EXISTS (
      SELECT 1 FROM objects
      WHERE project_id = $projectId AND object_type_id = ${type} AND primary_id = ${id}
    ) THEN 'true' ELSE 'false' END)
  END`
}

/**
 * The revision of a link identity, from its qualified key column `key`: its effective row, its
 * edge and slot overrides, the live source root asserting it, and the existence of both
 * endpoints. A live root that asserts a link is keyed by the link or by its source object.
 */
function linkRevision(key: string): string {
  const part = (index: number) => `json_extract(${key}, '$[${index}]')`
  return `json_array(
    (SELECT last_commit_id FROM links
      WHERE project_id = $projectId AND source_type_id = ${part(0)} AND source_id = ${part(1)}
        AND link_id = ${part(2)} AND target_type_id = ${part(3)} AND target_id = ${part(4)}),
    (SELECT overrides.last_commit_id FROM ontology_link_overrides AS overrides
      WHERE overrides.project_id = $projectId AND overrides.identity_kind = 'edge'
        AND overrides.identity_key = ${key}),
    (SELECT overrides.last_commit_id FROM ontology_link_overrides AS overrides
      WHERE overrides.project_id = $projectId AND overrides.identity_kind = 'slot'
        AND overrides.identity_key = json_array(${part(0)}, ${part(1)}, ${part(2)})),
    (SELECT MAX(roots.id) FROM ontology_source_roots AS roots
      CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
        AND versions.status IN ${PUBLISHED}
      WHERE roots.project_id = $projectId AND roots.retired_at IS NULL AND roots.deleted = 0
        AND roots.root_key IN (
          '["link",' || substr(${key}, 2),
          '["object",' || substr(json_array(${part(0)}, ${part(1)}), 2)
        )
        AND EXISTS (
          -- \`+\` keeps the lookup on the root's few rows, not on every row of a hub source.
          SELECT 1 FROM ontology_source_rows AS rows
          WHERE rows.root_id = roots.id AND +rows.entity_kind = 'link'
            AND +rows.source_type_id = ${part(0)} AND +rows.source_primary_id = ${part(1)}
            AND +rows.link_id = ${part(2)} AND +rows.target_type_id = ${part(3)}
            AND +rows.target_primary_id = ${part(4)}
        )),
    ${endpointRevision(part(0), part(1))},
    ${endpointRevision(part(3), part(4))}
  )`
}

/** The revision of the identity rows aliased `identities`. */
export function identityRevision(kind: "object" | "link"): string {
  const key = "identities.identity_key"
  return kind === "object"
    ? objectRevision(`json_extract(${key}, '$[0]')`, `json_extract(${key}, '$[1]')`)
    : linkRevision(key)
}

/**
 * The statements of `expandLinks`, `$versionId` and `$projectId` bound. Incident objects drive the
 * loop and each side seeks its own index: without statistics, SQLite would search every link and
 * override of the project once per object.
 */
export const EXPAND_LINK_STATEMENTS = {
  incident: `WITH incident_objects AS (
    SELECT DISTINCT json_extract(payload, '$.ref.objectTypeId') AS object_type_id,
      json_extract(payload, '$.ref.primaryId') AS primary_id
    FROM ${SQLITE_PLAN_WORK_TABLE}
    WHERE work_id = $versionId AND kind = 'incident-object'
  ), incident_links AS (
    SELECT links.source_type_id, links.source_id, links.link_id,
      links.target_type_id, links.target_id
    FROM incident_objects CROSS JOIN links
      ON links.project_id = $projectId
     AND links.source_type_id = incident_objects.object_type_id
     AND links.source_id = incident_objects.primary_id
    UNION
    SELECT links.source_type_id, links.source_id, links.link_id,
      links.target_type_id, links.target_id
    FROM incident_objects CROSS JOIN links INDEXED BY idx_links_target
      ON links.project_id = $projectId
     AND links.target_type_id = incident_objects.object_type_id
     AND links.target_id = incident_objects.primary_id
    UNION
    SELECT overrides.source_type_id, overrides.source_primary_id, overrides.link_id,
      overrides.target_type_id, overrides.target_primary_id
    FROM incident_objects CROSS JOIN ontology_link_overrides AS overrides
      ON overrides.project_id = $projectId AND overrides.identity_kind IN ('edge', 'slot')
     AND overrides.source_type_id = incident_objects.object_type_id
     AND overrides.source_primary_id = incident_objects.primary_id
    UNION
    SELECT overrides.source_type_id, overrides.source_primary_id, overrides.link_id,
      overrides.target_type_id, overrides.target_primary_id
    FROM incident_objects
    CROSS JOIN ontology_link_overrides AS overrides INDEXED BY idx_ontology_link_overrides_target
      ON overrides.project_id = $projectId
     AND overrides.target_type_id = incident_objects.object_type_id
     AND overrides.target_primary_id = incident_objects.primary_id
    UNION
    SELECT rows.source_type_id, rows.source_primary_id, rows.link_id,
      rows.target_type_id, rows.target_primary_id
    FROM incident_objects CROSS JOIN ontology_source_rows AS rows
      ON rows.entity_kind = 'link'
     AND rows.source_type_id = incident_objects.object_type_id
     AND rows.source_primary_id = incident_objects.primary_id
    CROSS JOIN ontology_source_roots AS roots ON roots.id = rows.root_id
      AND roots.project_id = $projectId AND roots.retired_at IS NULL AND roots.deleted = 0
    CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      AND versions.status IN ${PUBLISHED}
    UNION
    SELECT rows.source_type_id, rows.source_primary_id, rows.link_id,
      rows.target_type_id, rows.target_primary_id
    FROM incident_objects CROSS JOIN ontology_source_rows AS rows
      ON rows.entity_kind = 'link'
     AND rows.target_type_id = incident_objects.object_type_id
     AND rows.target_primary_id = incident_objects.primary_id
    CROSS JOIN ontology_source_roots AS roots ON roots.id = rows.root_id
      AND roots.project_id = $projectId AND roots.retired_at IS NULL AND roots.deleted = 0
    CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      AND versions.status IN ${PUBLISHED}
  )
  INSERT INTO ${IDENTITIES} (version_id, entity_kind, identity_key, sort_key, diff_required)
  SELECT $versionId, 'link', identity_key, ${SORT_KEY}, 1
  FROM (
    SELECT json_array(source_type_id, source_id, link_id, target_type_id, target_id)
      AS identity_key
    FROM incident_links
  ) WHERE true
  ON CONFLICT (version_id, entity_kind, identity_key) DO UPDATE
  SET diff_required = 1, read_revision = NULL, planned_revision = NULL, classified = 0,
    change = NULL
  WHERE ${IDENTITIES}.diff_required = 0`,
  members: `WITH scopes AS (
    SELECT DISTINCT json_extract(identity_key, '$[0]') AS source_type_id,
      json_extract(identity_key, '$[1]') AS source_id,
      json_extract(identity_key, '$[2]') AS link_id
    FROM ${IDENTITIES}
    WHERE version_id = $versionId AND entity_kind = 'link' AND diff_required = 1
  ), members AS (
    SELECT links.source_type_id, links.source_id, links.link_id,
      links.target_type_id, links.target_id
    FROM scopes CROSS JOIN links
      ON links.project_id = $projectId
     AND links.source_type_id = scopes.source_type_id
     AND links.source_id = scopes.source_id AND links.link_id = scopes.link_id
    UNION
    SELECT overrides.source_type_id, overrides.source_primary_id, overrides.link_id,
      overrides.target_type_id, overrides.target_primary_id
    FROM scopes CROSS JOIN ontology_link_overrides AS overrides
      ON overrides.project_id = $projectId AND overrides.identity_kind = 'slot'
     AND overrides.source_type_id = scopes.source_type_id
     AND overrides.source_primary_id = scopes.source_id
     AND overrides.link_id = scopes.link_id
  )
  INSERT INTO ${IDENTITIES} (version_id, entity_kind, identity_key, sort_key, diff_required)
  SELECT $versionId, 'link', identity_key, ${SORT_KEY}, 0
  FROM (
    SELECT json_array(source_type_id, source_id, link_id, target_type_id, target_id)
      AS identity_key
    FROM members
  ) WHERE true
  ON CONFLICT (version_id, entity_kind, identity_key) DO NOTHING`,
}

export class SqliteOntologyReplacementPlanStorage implements OntologyReplacementPlanStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  async open(input: OpenReplacementPlanInput): Promise<OpenedReplacementPlan> {
    return this.runRootOperation(() => {
      const { commit } = input
      assertReplacementPlanCommit(commit)
      const candidate = this.requireCandidate(input)
      const active = this.db
        .query(
          `SELECT materialization_id, last_commit_id FROM ontology_sources
           WHERE project_id = ? AND source_id = ? AND status = 'active'`
        )
        .get(input.projectId, input.source.projectionId) as {
        readonly materialization_id: string
        readonly last_commit_id: string | null
      } | null
      const replacedMaterializationId = active?.materialization_id ?? null
      const replacedLastCommitId = active?.last_commit_id ?? null
      const existing = planRow(this.db, candidate.version_id)
      // A plan decides the entities of the source it replaces: once that moved, it starts over.
      if (
        existing?.replaced_materialization_id === replacedMaterializationId &&
        existing.replaced_last_commit_id === replacedLastCommitId
      ) {
        return { committedAt: existing.committed_at }
      }
      if (existing) deletePlan(this.db, candidate.version_id)
      this.db
        .query(
          `INSERT INTO ontology_replacement_plans (
             version_id, project_id, commit_id, committed_at, replaced_materialization_id,
             replaced_last_commit_id, watermark
           ) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(rowid), 0) FROM ontology_commits))`
        )
        .run(
          candidate.version_id,
          input.projectId,
          commit.id,
          commit.committedAt,
          replacedMaterializationId,
          replacedLastCommitId
        )
      const rows = replacementSourceRows(this.db, {
        projectId: input.projectId,
        sourceId: input.source.projectionId,
        materializationId: input.materializationId,
        incremental: candidate.base_materialization_id !== null,
      })
      // Every entity of the candidate and of the roots it replaces needs a diff.
      this.db
        .query(
          `INSERT INTO ${IDENTITIES} (version_id, entity_kind, identity_key, sort_key, diff_required)
           SELECT ?, entity_kind, identity_key, ${SORT_KEY}, 1
           FROM (
             SELECT entity_kind, CASE entity_kind
               WHEN 'object' THEN json_array(object_type_id, primary_id)
               ELSE json_array(
                 source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
               )
             END AS identity_key
             FROM (${rows.sql}) AS rows
           )
           GROUP BY entity_kind, identity_key`
        )
        .run(candidate.version_id, ...rows.values)
      return { committedAt: commit.committedAt }
    })
  }

  async *streamState(
    input: StreamReplacementPlanStateInput
  ): AsyncIterable<ReplacementPlanStatePage> {
    assertPageRows(input.pageRows)
    await this.runRootOperation(() => {
      const { candidate } = this.requirePlan(input)
      if (input.entityKind === "object" && candidate.projection_kind !== "object") {
        throw new MaterializationConflictError(
          "source-materialization",
          "Link projection replacement cannot stream object state."
        )
      }
      if (input.entityKind === "link") {
        if (unplannedCount(this.db, candidate.version_id, "object") > 0) {
          throw new MaterializationConflictError(
            "effective-state",
            "Object projection replacement must plan every object before its links."
          )
        }
        this.expandLinks(candidate.version_id, input.projectId)
      }
    })
    let after = ""
    while (true) {
      const page = await this.runRootOperation(() => {
        const { candidate } = this.requirePlan(input)
        const rows = this.db
          .query(
            `SELECT identity_key, sort_key, diff_required FROM ${IDENTITIES}
             WHERE version_id = ? AND entity_kind = ? AND planned_revision IS NULL AND sort_key > ?
             ORDER BY sort_key
             LIMIT ?`
          )
          .all(candidate.version_id, input.entityKind, after, input.pageRows) as IdentityRow[]
        if (rows.length === 0) return null
        after = rows[rows.length - 1]!.sort_key
        const state = this.readPage(input, candidate, rows)
        this.db
          .query(
            `UPDATE ${IDENTITIES} AS identities SET read_revision = ${identityRevision(input.entityKind)}
             WHERE identities.version_id = $versionId AND identities.entity_kind = $entityKind
               AND identities.identity_key IN (SELECT value FROM json_each($keys))`
          )
          .run({
            $projectId: input.projectId,
            $versionId: candidate.version_id,
            $entityKind: input.entityKind,
            $keys: JSON.stringify(rows.map((row) => row.identity_key)),
          })
        return state
      })
      if (!page) return
      yield page
    }
  }

  async stage(input: StageReplacementPlanInput): Promise<void> {
    await this.runRootOperation(() => {
      const { plan, candidate } = this.requirePlan(input)
      const identities = prepareReplacementIdentities(input, {
        commitId: plan.commit_id,
        committedAt: plan.committed_at,
      })
      const versionId = candidate.version_id
      this.db.run("SAVEPOINT sixb_replacement_plan_stage")
      let recordKey: string | undefined
      try {
        // Only an identity streamed and still to plan has the revision its work is planned
        // from, and holds no work: unplanning one deletes its work and forgets what it read.
        const known = this.db.query(
          `SELECT read_revision, planned_revision FROM ${IDENTITIES}
           WHERE version_id = ? AND entity_kind = ? AND identity_key = ?`
        )
        const insert = this.db.query(
          `INSERT INTO ${SQLITE_PLAN_WORK_TABLE} (
             work_id, entity_kind, identity_key, record_key, unique_key, kind, lane,
             major_order, minor_order, sort_one, sort_two,
             classification_entity_kind, classification_identity_key,
             cardinality_view, cardinality_occupied, cardinality_source_type_id,
             cardinality_source_primary_id, cardinality_link_id,
             cardinality_target_type_id, cardinality_target_primary_id, payload
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))`
        )
        const planned = this.db.query(
          `UPDATE ${IDENTITIES}
           SET planned_revision = read_revision, classified = ?, change = ?
           WHERE version_id = ? AND entity_kind = ? AND identity_key = ?`
        )
        for (const identity of identities) {
          const row = known.get(versionId, identity.kind, identity.key) as {
            readonly read_revision: string | null
            readonly planned_revision: string | null
          } | null
          if (row?.read_revision == null || row.planned_revision !== null) {
            throw new MaterializationValidationError(
              `Replacement identity ${identity.entityKey} is not streamed and still to plan.`
            )
          }
          for (const record of identity.records) {
            recordKey = record.recordKey
            const columns = materializationWorkColumns(record)
            const classification = record.kind === "classification" ? record : null
            const cardinality = record.kind === "cardinality" ? record : null
            insert.run(
              versionId,
              identity.kind,
              identity.key,
              record.recordKey,
              workUniquenessKey(record),
              record.kind,
              columns.lane,
              columns.majorOrder,
              columns.minorOrder,
              columns.sortOne,
              columns.sortTwo,
              classification?.entityKind ?? null,
              classification?.identityKey ?? null,
              cardinality?.view ?? null,
              cardinality ? Number(cardinality.occupied) : null,
              cardinality?.ref.source.objectTypeId ?? null,
              cardinality?.ref.source.primaryId ?? null,
              cardinality?.ref.linkId ?? null,
              cardinality?.ref.target.objectTypeId ?? null,
              cardinality?.ref.target.primaryId ?? null,
              canonicalJson(record)
            )
          }
          planned.run(
            Number(identity.classified),
            identity.change,
            versionId,
            identity.kind,
            identity.key
          )
        }
        this.db.run("RELEASE SAVEPOINT sixb_replacement_plan_stage")
      } catch (error) {
        this.db.run("ROLLBACK TO SAVEPOINT sixb_replacement_plan_stage")
        this.db.run("RELEASE SAVEPOINT sixb_replacement_plan_stage")
        if (isSqliteConstraintError(error)) throw duplicateMaterializationWork(recordKey)
        throw error
      }
    })
  }

  async refresh(input: ReplacementPlanRef): Promise<ReplacementPlanStatus> {
    return this.runRootOperation(() => {
      const { plan, candidate } = this.requirePlan(input)
      const versionId = candidate.version_id
      const pending = unplannedCount(this.db, versionId)
      if (pending > 0) return { fresh: false, unplanned: pending }
      if (!committedSince(this.db, plan, input.projectId)) {
        return { fresh: true, counts: replacementPlanCounts(this.db, versionId) }
      }
      let unplanned = 0
      for (const kind of ["object", "link"] as const) {
        const stale = this.db
          .query(
            `UPDATE ${IDENTITIES} AS identities
             SET read_revision = NULL, planned_revision = NULL, classified = 0, change = NULL
             WHERE identities.version_id = $versionId AND identities.entity_kind = $entityKind
               AND identities.planned_revision IS NOT ${identityRevision(kind)}`
          )
          .run({ $projectId: input.projectId, $versionId: versionId, $entityKind: kind }).changes
        if (stale === 0) continue
        dropUnplannedWork(this.db, versionId, kind)
        unplanned += stale
      }
      unplanned += this.expandLinks(versionId, input.projectId)
      this.db
        .query(
          `UPDATE ontology_replacement_plans
           SET watermark = (SELECT COALESCE(MAX(rowid), 0) FROM ontology_commits)
           WHERE version_id = ?`
        )
        .run(versionId)
      if (unplanned > 0) return { fresh: false, unplanned }
      return { fresh: true, counts: replacementPlanCounts(this.db, versionId) }
    })
  }

  async purge(input: PurgeReplacementPlansInput): Promise<number> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Replacement plan purge project id")
      assertPositiveInteger(input.limit, "Replacement plan purge limit")
      const spentPlan = this.db.query(
        `SELECT plans.version_id FROM ontology_replacement_plans AS plans
         JOIN ontology_sources AS versions USING (version_id)
         WHERE plans.project_id = ? AND versions.status <> 'ready'
         ORDER BY plans.version_id
         LIMIT 1`
      )
      let deleted = 0
      // A plan's row goes last, so a plan whose rows outlast the budget is found again next time.
      while (deleted < input.limit) {
        const spent = spentPlan.get(input.projectId) as { readonly version_id: number } | null
        if (!spent) return deleted
        for (const [table, column] of [
          [SQLITE_PLAN_WORK_TABLE, "work_id"],
          [IDENTITIES, "version_id"],
        ] as const) {
          deleted += this.db
            .query(
              `DELETE FROM ${table} WHERE rowid IN (
                 SELECT rowid FROM ${table} WHERE ${column} = ? LIMIT ?
               )`
            )
            .run(spent.version_id, input.limit - deleted).changes
          if (deleted >= input.limit) return deleted
        }
        this.db
          .query(`DELETE FROM ontology_replacement_plans WHERE version_id = ?`)
          .run(spent.version_id)
        deleted += 1
      }
      return deleted
    })
  }

  private readPage(
    input: StreamReplacementPlanStateInput,
    candidate: SqliteOntologySourceRow,
    rows: readonly IdentityRow[]
  ): ReplacementPlanStatePage {
    const reader = new SqliteMaterializationStateReader(this.db, input.projectId)
    if (input.entityKind === "object") {
      const refs = rows.map((row) => {
        const [objectTypeId, primaryId] = parseJson<string[]>(row.identity_key)
        return { objectTypeId: objectTypeId!, primaryId: primaryId! }
      })
      return {
        objects: reader.replacementObjectStates(
          input.source.projectionId,
          input.materializationId,
          refs
        ),
        links: [],
        endpoints: [],
      }
    }
    const identities = rows.map((row) => {
      const parts = parseJson<string[]>(row.identity_key)
      const ref: OntologyLinkRef = {
        source: { objectTypeId: parts[0]!, primaryId: parts[1]! },
        linkId: parts[2]!,
        target: { objectTypeId: parts[3]!, primaryId: parts[4]! },
      }
      return {
        ref,
        sortKey: row.sort_key,
        diffRequired: row.diff_required === 1,
      }
    })
    const previous = this.db
      .query(
        `SELECT materialization_id FROM ontology_sources
         WHERE project_id = ? AND source_id = ? AND status = 'active'`
      )
      .get(input.projectId, input.source.projectionId) as {
      readonly materialization_id: string
    } | null
    const links = reader.replacementLinkStates(
      input.source.projectionId,
      input.materializationId,
      [input.materializationId, ...(previous ? [previous.materialization_id] : [])],
      identities,
      candidate.base_materialization_id !== null
    )
    return {
      objects: [],
      links,
      endpoints: this.endpoints(
        candidate.version_id,
        input.projectId,
        identities.flatMap(({ ref }) => [ref.source, ref.target])
      ),
    }
  }

  /** Planned existence where the plan decides an endpoint, effective existence elsewhere. */
  private endpoints(
    versionId: number,
    projectId: string,
    refs: readonly OntologyObjectRef[]
  ): MaterializationObjectExistence[] {
    const unique = [...new Map(refs.map((ref) => [objectRefKey(ref), ref] as const)).values()]
    const rows = this.db
      .query(
        `SELECT requested.value AS identity_key, (
           SELECT json_extract(work.payload, '$.exists') FROM ${SQLITE_PLAN_WORK_TABLE} AS work
           WHERE work.work_id = ? AND work.unique_key = 'object-existence:' || requested.value
         ) AS planned, EXISTS (
           SELECT 1 FROM objects
           WHERE project_id = ? AND object_type_id = json_extract(requested.value, '$[0]')
             AND primary_id = json_extract(requested.value, '$[1]')
         ) AS effective
         FROM json_each(?) AS requested`
      )
      .all(versionId, projectId, JSON.stringify(unique.map((ref) => objectRefKey(ref)))) as {
      readonly identity_key: string
      readonly planned: number | null
      readonly effective: number
    }[]
    const existence = new Map(
      rows.map((row) => [row.identity_key, (row.planned ?? row.effective) === 1] as const)
    )
    return unique.map((ref) => ({ ref, exists: existence.get(objectRefKey(ref)) ?? false }))
  }

  /**
   * Adds the links the plan must decide besides its own: those incident to an object it flips,
   * and every member of a scope it changes. Returns how many identities this left to plan,
   * counting an existing member that now needs a diff.
   */
  private expandLinks(versionId: number, projectId: string): number {
    const run = (statement: string) =>
      this.db.query(statement).run({ $projectId: projectId, $versionId: versionId }).changes
    const diffLinks = run(EXPAND_LINK_STATEMENTS.incident)
    const members = run(EXPAND_LINK_STATEMENTS.members)
    // An upgraded member planned without a diff keeps no work from before.
    if (diffLinks > 0) dropUnplannedWork(this.db, versionId, "link")
    return diffLinks + members
  }

  private requireCandidate(input: ReplacementPlanRef): SqliteOntologySourceRow {
    const candidate = sourceRow(
      this.db,
      input.projectId,
      input.source.projectionId,
      input.materializationId
    )
    if (
      !candidate ||
      candidate.status !== "ready" ||
      candidate.projection_run_id !== input.execution.projectionRunId ||
      candidate.execution_token !== input.execution.executionToken
    ) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Candidate source materialization '${input.materializationId}' is missing, not ready, or owned by another execution.`
      )
    }
    assertProjectionExecution(this.db, {
      projectId: input.projectId,
      sourceId: input.source.projectionId,
      projectionRunId: input.execution.projectionRunId,
      executionToken: input.execution.executionToken,
    })
    return candidate
  }

  private requirePlan(input: ReplacementPlanRef): {
    readonly plan: PlanRow
    readonly candidate: SqliteOntologySourceRow
  } {
    const candidate = this.requireCandidate(input)
    const plan = planRow(this.db, candidate.version_id)
    if (!plan) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Candidate source materialization '${input.materializationId}' has no open plan.`
      )
    }
    return { plan, candidate }
  }
}

/**
 * Every identity the plan decides with a diff is classified, and nothing else is. Staging records
 * whether an identity's work holds its classification, so this reads identities only.
 */
export function assertReplacementPlanCoverage(db: Database, plan: SqliteReplacementPlan): void {
  const mismatch = db
    .query(
      `SELECT 1 FROM ${IDENTITIES}
       WHERE version_id = ?
         AND classified <> (diff_required AND (entity_kind = 'link' OR ? = 1))
       LIMIT 1`
    )
    .get(plan.versionId, plan.projectionKind === "object" ? 1 : 0)
  if (mismatch) {
    invalidCorrelation("Projection replacement classification coverage does not match its plan.")
  }
}

/** The change counts of a plan, from what its identities planned. */
export function replacementPlanCounts(db: Database, versionId: number): EffectiveChangeCounts {
  const rows = db
    .query(
      `SELECT entity_kind, COALESCE(change, 'unchanged') AS change, COUNT(*) AS count
       FROM ${IDENTITIES}
       WHERE version_id = ? AND classified = 1
       GROUP BY entity_kind, COALESCE(change, 'unchanged')`
    )
    .all(versionId) as {
    readonly entity_kind: "object" | "link"
    readonly change: "created" | "updated" | "deleted" | "unchanged"
    readonly count: number
  }[]
  const count = (kind: "object" | "link", change: string) =>
    rows.find((row) => row.entity_kind === kind && row.change === change)?.count ?? 0
  return {
    objectsCreated: count("object", "created"),
    objectsUpdated: count("object", "updated"),
    objectsDeleted: count("object", "deleted"),
    objectsUnchanged: count("object", "unchanged"),
    linksCreated: count("link", "created"),
    linksUpdated: count("link", "updated"),
    linksDeleted: count("link", "deleted"),
    linksUnchanged: count("link", "unchanged"),
  }
}

function unplannedCount(db: Database, versionId: number, kind?: "object" | "link"): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM ${IDENTITIES}
       WHERE version_id = ? AND planned_revision IS NULL AND (? IS NULL OR entity_kind = ?)`
    )
    .get(versionId, kind ?? null, kind ?? null) as { readonly count: number }
  return row.count
}

/**
 * Whether a commit of the project landed after the plan's watermark. Commit rows are never deleted
 * and every write holds the store's lock, so their rowids grow in commit order.
 */
function committedSince(db: Database, plan: PlanRow, projectId: string): boolean {
  // `+project_id` keeps the lookup on the rowid range instead of the project's whole history.
  return (
    db
      .query(`SELECT 1 FROM ontology_commits WHERE rowid > ? AND +project_id = ? LIMIT 1`)
      .get(plan.watermark, projectId) !== null
  )
}

/** Deletes the work of the identities of `kind` left to plan: an identity to plan holds none. */
function dropUnplannedWork(db: Database, versionId: number, kind: "object" | "link"): void {
  db.query(
    `DELETE FROM ${SQLITE_PLAN_WORK_TABLE}
     WHERE work_id = ? AND entity_kind = ? AND identity_key IN (
       SELECT identity_key FROM ${IDENTITIES}
       WHERE version_id = ? AND entity_kind = ? AND planned_revision IS NULL
     )`
  ).run(versionId, kind, versionId, kind)
}

function deletePlan(db: Database, versionId: number): void {
  db.query(`DELETE FROM ${SQLITE_PLAN_WORK_TABLE} WHERE work_id = ?`).run(versionId)
  db.query(`DELETE FROM ${IDENTITIES} WHERE version_id = ?`).run(versionId)
  db.query(`DELETE FROM ontology_replacement_plans WHERE version_id = ?`).run(versionId)
}

function planRow(db: Database, versionId: number): PlanRow | null {
  return db
    .query(`SELECT * FROM ontology_replacement_plans WHERE version_id = ?`)
    .get(versionId) as PlanRow | null
}

function sourceRow(
  db: Database,
  projectId: string,
  sourceId: string,
  materializationId: string
): SqliteOntologySourceRow | null {
  return db
    .query(
      `SELECT * FROM ontology_sources
       WHERE project_id = ? AND source_id = ? AND materialization_id = ?`
    )
    .get(projectId, sourceId, materializationId) as SqliteOntologySourceRow | null
}

/** The fresh, fully planned plan a session applies, with exactly its commit. */
export function boundReplacementPlan(
  db: Database,
  header: {
    readonly commit: OntologyCommitWrite
    readonly plan?: {
      readonly source: { readonly projectionId: string }
      readonly materializationId: string
    }
  }
): SqliteReplacementPlan {
  const ref = header.plan
  const candidate = ref
    ? sourceRow(db, header.commit.projectId, ref.source.projectionId, ref.materializationId)
    : null
  const plan = candidate ? planRow(db, candidate.version_id) : null
  if (!ref || !candidate || !plan || header.commit.intent.kind !== "projection") {
    throw new MaterializationConflictError(
      "source-materialization",
      "A plan-bound session needs the open plan of a projection candidate."
    )
  }
  if (plan.commit_id !== header.commit.id || plan.committed_at !== header.commit.committedAt) {
    throw new MaterializationValidationError(
      "A plan-bound session must begin with the commit its plan carries."
    )
  }
  if (
    committedSince(db, plan, header.commit.projectId) ||
    unplannedCount(db, candidate.version_id) > 0
  ) {
    throw new MaterializationValidationError(
      "A replacement plan applies only fully planned and just refreshed."
    )
  }
  return { versionId: candidate.version_id, projectionKind: candidate.projection_kind }
}
