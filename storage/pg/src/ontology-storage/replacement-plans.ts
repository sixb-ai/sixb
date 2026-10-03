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
import type { SQLClient } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import { runPgTransaction } from "../transactions"
import { jsonTupleExpression, PgMaterializationStateReader } from "./materialization-state"
import {
  assertProjectionExecution,
  jsonParameter,
  type PgOntologySourceRow,
  toIsoString,
} from "./shared"
import { liveSourceRowsJoin, PUBLISHED, replacementSourceRows } from "./source-roots"

export const PG_PLAN_WORK_TABLE = "ontology_replacement_plan_work"
const IDENTITIES = "ontology_replacement_plan_identities"
/** An identity's planning order: its key's UTF-8 bytes, as `objectRefSortKey`/`linkRefSortKey`. */
const SORT_KEY = "encode(convert_to(identity_key, 'UTF8'), 'hex')"

/**
 * Rows a plan writes at once before its tables are analyzed again. Autovacuum lags behind a bulk
 * write, and with the statistics of near-empty tables the planner scans a plan's whole work for
 * each keyed lookup instead of seeking it.
 */
const ANALYZE_ROWS = 10_000

/** The plan a session applies: its work rows carry the candidate's source version as `work_id`. */
export interface PgReplacementPlan {
  readonly versionId: string
  readonly projectionKind: "object" | "link"
}

interface PlanRow {
  readonly version_id: string
  readonly commit_id: string
  readonly committed_at: Date | string
  readonly replaced_materialization_id: string | null
  readonly replaced_last_commit_id: string | null
}

interface IdentityRow {
  readonly identity_key: string
  readonly sort_key: string
  readonly diff_required: boolean
}

/**
 * The revision of an object identity: its effective row, its override and the latest point of each
 * telemetry property. `type` and `id` are SQL expressions; `$1` is the project id.
 */
function objectRevision(type: string, id: string): string {
  return `jsonb_build_array(
    (SELECT jsonb_build_array(version, last_commit_id) FROM objects
      WHERE project_id = $1 AND object_type_id = ${type} AND primary_id = ${id}),
    (SELECT last_commit_id FROM ontology_object_overrides
      WHERE project_id = $1 AND object_type_id = ${type} AND primary_id = ${id}),
    -- An instant, not its rendering in the session's time zone.
    (SELECT jsonb_agg(
        jsonb_build_array(property_id, extract(epoch FROM at), last_commit_id) ORDER BY property_id
      )
      FROM timeseries_latest
      WHERE project_id = $1 AND object_type_id = ${type} AND object_id = ${id})
  )`
}

/**
 * The revision of a link endpoint, which a link plan reads only for its existence. One this plan
 * decides exists as planned, which follows its whole object revision; any other exists as it is.
 * `$2` is the plan's version id.
 */
function endpointRevision(type: string, id: string): string {
  return `CASE WHEN EXISTS (
      SELECT 1 FROM ${IDENTITIES} AS endpoint
      WHERE endpoint.version_id = $2 AND endpoint.entity_kind = 'object'
        AND endpoint.identity_key = ${jsonTupleExpression([`to_jsonb(${type})::text`, `to_jsonb(${id})::text`])}
    ) THEN ${objectRevision(type, id)}
    ELSE to_jsonb(EXISTS (
      SELECT 1 FROM objects WHERE project_id = $1 AND object_type_id = ${type} AND primary_id = ${id}
    ))
  END`
}

/**
 * The revision of a link identity, from its key column `key`: its effective row, its edge and slot
 * overrides, the live source root asserting it, and the existence of both endpoints. A live root
 * that asserts a link is keyed by the link or by its source object.
 */
function linkRevision(key: string): string {
  const part = (index: number) => `(${key}::jsonb->>${index})`
  return `jsonb_build_array(
    (SELECT last_commit_id FROM links
      WHERE project_id = $1 AND source_type_id = ${part(0)} AND source_id = ${part(1)}
        AND link_id = ${part(2)} AND target_type_id = ${part(3)} AND target_id = ${part(4)}),
    (SELECT last_commit_id FROM ontology_link_overrides
      WHERE project_id = $1 AND identity_kind = 'edge' AND identity_key = ${key}::jsonb),
    (SELECT last_commit_id FROM ontology_link_overrides
      WHERE project_id = $1 AND identity_kind = 'slot'
        AND identity_key = jsonb_build_array(${part(0)}, ${part(1)}, ${part(2)})),
    (SELECT MAX(roots.id) FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
        AND versions.status IN ${PUBLISHED}
      WHERE roots.project_id = $1 AND roots.retired_at IS NULL AND NOT roots.deleted
        AND roots.root_key IN (
          '["link",' || substr(${key}, 2),
          ${jsonTupleExpression([`'"object"'`, `to_jsonb(${part(0)})::text`, `to_jsonb(${part(1)})::text`])}
        )
        AND EXISTS (
          SELECT 1 FROM ontology_source_rows AS rows
          WHERE rows.root_id = roots.id AND rows.entity_kind = 'link'
            AND rows.source_type_id = ${part(0)} AND rows.source_primary_id = ${part(1)}
            AND rows.link_id = ${part(2)} AND rows.target_type_id = ${part(3)}
            AND rows.target_primary_id = ${part(4)}
        )),
    ${endpointRevision(part(0), part(1))},
    ${endpointRevision(part(3), part(4))}
  )`
}

/** The revision of the identity rows aliased `identities`, as text. */
function revision(kind: "object" | "link"): string {
  const key = "identities.identity_key"
  return kind === "object"
    ? `${objectRevision(`(${key}::jsonb->>0)`, `(${key}::jsonb->>1)`)}::text`
    : `${linkRevision(key)}::text`
}

export class PgOntologyReplacementPlanStorage implements OntologyReplacementPlanStorage {
  constructor(private readonly sql: SQLClient) {}

  async open(input: OpenReplacementPlanInput): Promise<OpenedReplacementPlan> {
    const { commit } = input
    assertReplacementPlanCommit(commit)
    return runPgTransaction(this.sql, async (sql) => {
      const candidate = await requireCandidate(sql, input, true)
      const [active] = await sql<
        { readonly materialization_id: string; readonly last_commit_id: string | null }[]
      >`
        SELECT materialization_id, last_commit_id FROM ontology_sources
        WHERE project_id = ${input.projectId} AND source_id = ${input.source.projectionId}
          AND status = 'active'
      `
      const replacedMaterializationId = active?.materialization_id ?? null
      const replacedLastCommitId = active?.last_commit_id ?? null
      const existing = await planRow(sql, candidate.version_id)
      // A plan decides the entities of the source it replaces: once that moved, it starts over.
      if (
        existing?.replaced_materialization_id === replacedMaterializationId &&
        existing.replaced_last_commit_id === replacedLastCommitId
      ) {
        return { committedAt: toIsoString(existing.committed_at) }
      }
      if (existing) await deletePlan(sql, candidate.version_id)
      await sql`
        INSERT INTO ontology_replacement_plans (
          version_id, project_id, commit_id, committed_at, replaced_materialization_id,
          replaced_last_commit_id, watermark
        ) VALUES (
          ${candidate.version_id}, ${input.projectId}, ${commit.id}, ${commit.committedAt},
          ${replacedMaterializationId}, ${replacedLastCommitId}, pg_current_snapshot()
        )
      `
      const rows = replacementSourceRows(sql, {
        projectId: input.projectId,
        sourceId: input.source.projectionId,
        materializationId: input.materializationId,
        incremental: candidate.base_materialization_id !== null,
      })
      // Every entity of the candidate and of the roots it replaces needs a diff.
      const opened = await sql`
        WITH keyed AS (
          SELECT DISTINCT entity_kind, CASE entity_kind
            WHEN 'object' THEN ${sql.unsafe(keyExpression(["object_type_id", "primary_id"]))}
            ELSE ${sql.unsafe(
              keyExpression([
                "source_type_id",
                "source_primary_id",
                "link_id",
                "target_type_id",
                "target_primary_id",
              ])
            )}
          END AS identity_key
          FROM (${rows}) AS rows
        )
        INSERT INTO ${sql(IDENTITIES)} (version_id, entity_kind, identity_key, sort_key, diff_required)
        SELECT ${candidate.version_id}, entity_kind, identity_key,
          ${sql.unsafe(SORT_KEY)}, TRUE
        FROM keyed
      `
      if (opened.count >= ANALYZE_ROWS) await analyzePlans(sql)
      return { committedAt: commit.committedAt }
    })
  }

  async *streamState(
    input: StreamReplacementPlanStateInput
  ): AsyncIterable<ReplacementPlanStatePage> {
    assertPageRows(input.pageRows)
    await runPgTransaction(this.sql, async (sql) => {
      const { candidate } = await requirePlan(sql, input)
      if (input.entityKind === "object" && candidate.projection_kind !== "object") {
        throw new MaterializationConflictError(
          "source-materialization",
          "Link projection replacement cannot stream object state."
        )
      }
      if (input.entityKind === "link") {
        if ((await unplannedCount(sql, candidate.version_id, "object")) > 0) {
          throw new MaterializationConflictError(
            "effective-state",
            "Object projection replacement must plan every object before its links."
          )
        }
        if ((await expandLinks(sql, candidate.version_id, input.projectId)) >= ANALYZE_ROWS) {
          await analyzePlans(sql)
        }
      }
    })
    let after = ""
    let streamed = 0
    while (true) {
      // Each page reads its state and the revision of that state in one snapshot.
      const page = await runPgTransaction(
        this.sql,
        async (sql) => {
          const { candidate } = await requirePlan(sql, input)
          const rows = await sql<IdentityRow[]>`
            SELECT identity_key, sort_key, diff_required FROM ${sql(IDENTITIES)}
            WHERE version_id = ${candidate.version_id} AND entity_kind = ${input.entityKind}
              AND planned_revision IS NULL AND sort_key > ${after}
            ORDER BY sort_key
            LIMIT ${input.pageRows}
          `
          if (rows.length === 0) return null
          after = rows[rows.length - 1]!.sort_key
          streamed += rows.length
          const state = await readPage(sql, input, candidate, rows)
          await sql.unsafe(
            `UPDATE ${IDENTITIES} AS identities
             SET read_revision = ${revision(input.entityKind)}
             WHERE version_id = $2 AND entity_kind = $3 AND identity_key = ANY($4::text[])`,
            [
              input.projectId,
              candidate.version_id,
              input.entityKind,
              rows.map((row) => row.identity_key),
            ]
          )
          return state
        },
        { isolation: "repeatableRead" }
      )
      if (!page) {
        // Every page is staged by now: later lookups and the commit join this work. Never in the
        // commit transaction, where ANALYZE would hold a lock other commits queue behind.
        if (streamed >= ANALYZE_ROWS) await analyzePlans(this.sql)
        return
      }
      yield page
    }
  }

  async stage(input: StageReplacementPlanInput): Promise<void> {
    await runPgTransaction(this.sql, async (sql) => {
      const { plan, candidate } = await requirePlan(sql, input)
      const identities = prepareReplacementIdentities(input, planCommit(plan))
      const versionId = candidate.version_id
      const summary = identities.map((identity) => ({
        entityKind: identity.kind,
        identityKey: identity.key,
        classified: identity.classified,
        change: identity.change,
      }))
      // Only an identity streamed and still to plan has the revision its work is planned from,
      // and holds no work: unplanning one deletes its work and forgets what it read.
      const planned = await sql`
        WITH planned AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(sql, summary)}::jsonb)
        )
        UPDATE ${sql(IDENTITIES)} AS identities
        SET planned_revision = identities.read_revision,
          classified = (planned.value->>'classified')::boolean,
          change = planned.value->>'change'
        FROM planned
        WHERE identities.version_id = ${versionId}
          AND identities.entity_kind = planned.value->>'entityKind'
          AND identities.identity_key = planned.value->>'identityKey'
          AND identities.read_revision IS NOT NULL AND identities.planned_revision IS NULL
        RETURNING identities.entity_kind, identities.identity_key
      `
      if (planned.length !== identities.length) {
        const streamed = new Set(planned.map((row) => `${row.entity_kind}:${row.identity_key}`))
        const missing = identities.find(
          (identity) => !streamed.has(`${identity.kind}:${identity.key}`)
        )
        throw new MaterializationValidationError(
          `Replacement identity ${missing?.entityKey} is not streamed and still to plan.`
        )
      }
      const work = identities.flatMap((identity) =>
        identity.records.map((record) => {
          const columns = materializationWorkColumns(record)
          return {
            entityKind: identity.kind,
            identityKey: identity.key,
            recordKey: record.recordKey,
            uniqueKey: workUniquenessKey(record),
            kind: record.kind,
            lane: columns.lane,
            majorOrder: columns.majorOrder,
            minorOrder: columns.minorOrder,
            sortOne: columns.sortOne,
            sortTwo: columns.sortTwo,
            occupied: record.kind === "cardinality" ? record.occupied : null,
            record,
          }
        })
      )
      if (work.length > 0) {
        try {
          await sql`
            WITH staged AS (
              SELECT value FROM jsonb_array_elements(${jsonParameter(sql, work)}::jsonb)
            )
            INSERT INTO ${sql(PG_PLAN_WORK_TABLE)} (
              work_id, entity_kind, identity_key, record_key, unique_key, kind, lane,
              major_order, minor_order, sort_one, sort_two, cardinality_occupied, payload
            )
            SELECT ${versionId}, value->>'entityKind', value->>'identityKey', value->>'recordKey',
              value->>'uniqueKey', value->>'kind', value->>'lane',
              (value->>'majorOrder')::integer, (value->>'minorOrder')::integer,
              value->>'sortOne', value->>'sortTwo', (value->>'occupied')::boolean,
              value->'record'
            FROM staged
          `
        } catch (error) {
          if (isUniqueViolation(error)) throw duplicateMaterializationWork()
          throw error
        }
      }
    })
  }

  async refresh(input: ReplacementPlanRef): Promise<ReplacementPlanStatus> {
    // Already within the commit transaction there: the unplanning and its work go together.
    return runPgTransaction(this.sql, async (sql) => {
      const { candidate } = await requirePlan(sql, input)
      const versionId = candidate.version_id
      const pending = await unplannedCount(sql, versionId)
      if (pending > 0) return { fresh: false, unplanned: pending }
      if (!(await committedSince(sql, versionId, input.projectId))) {
        return { fresh: true, counts: await replacementPlanCounts(sql, versionId) }
      }
      // Taken before the revisions are read, so a commit they might miss stays past the watermark.
      const [seen] = await sql<{ readonly snapshot: string }[]>`
        SELECT pg_current_snapshot()::text AS snapshot
      `
      let unplanned = 0
      for (const kind of ["object", "link"] as const) {
        const stale = await sql.unsafe(
          `UPDATE ${IDENTITIES} AS identities
           SET read_revision = NULL, planned_revision = NULL, classified = FALSE, change = NULL
           WHERE version_id = $2 AND entity_kind = $3
             AND planned_revision IS DISTINCT FROM ${revision(kind)}`,
          [input.projectId, versionId, kind]
        )
        if (stale.count === 0) continue
        await dropUnplannedWork(sql, versionId, kind)
        unplanned += stale.count
      }
      unplanned += await expandLinks(sql, versionId, input.projectId)
      await sql`
        UPDATE ontology_replacement_plans SET watermark = ${seen!.snapshot}::pg_snapshot
        WHERE version_id = ${versionId}
      `
      if (unplanned > 0) return { fresh: false, unplanned }
      return { fresh: true, counts: await replacementPlanCounts(sql, versionId) }
    })
  }

  async purge(input: PurgeReplacementPlansInput): Promise<number> {
    assertNonblank(input.projectId, "Replacement plan purge project id")
    assertPositiveInteger(input.limit, "Replacement plan purge limit")
    return runPgTransaction(this.sql, async (sql) => {
      let deleted = 0
      // A plan's row goes last, so a plan whose rows outlast the budget is found again next time.
      while (deleted < input.limit) {
        const [spent] = await sql<{ readonly version_id: string }[]>`
          SELECT plans.version_id FROM ontology_replacement_plans AS plans
          JOIN ontology_sources AS versions USING (version_id)
          WHERE plans.project_id = ${input.projectId} AND versions.status <> 'ready'
          ORDER BY plans.version_id
          LIMIT 1
        `
        if (!spent) return deleted
        for (const [table, column] of [
          [PG_PLAN_WORK_TABLE, "work_id"],
          [IDENTITIES, "version_id"],
        ] as const) {
          const rows = await sql`
            DELETE FROM ${sql(table)} WHERE ctid = ANY(ARRAY(
              SELECT ctid FROM ${sql(table)} WHERE ${sql(column)} = ${spent.version_id}
              LIMIT ${input.limit - deleted}
            ))
          `
          deleted += rows.count
          if (deleted >= input.limit) return deleted
        }
        await sql`DELETE FROM ontology_replacement_plans WHERE version_id = ${spent.version_id}`
        deleted += 1
      }
      return deleted
    })
  }
}

/** The fresh, fully planned plan a session applies, with exactly its commit. */
export async function boundReplacementPlan(
  sql: SQLClient,
  header: {
    readonly commit: OntologyCommitWrite
    readonly plan?: {
      readonly source: { readonly projectionId: string }
      readonly materializationId: string
    }
  }
): Promise<PgReplacementPlan> {
  const ref = header.plan
  const candidate = ref
    ? await sourceRow(sql, header.commit.projectId, ref.source.projectionId, ref.materializationId)
    : null
  const plan = candidate ? await planRow(sql, candidate.version_id) : null
  if (!ref || !candidate || !plan || header.commit.intent.kind !== "projection") {
    throw new MaterializationConflictError(
      "source-materialization",
      "A plan-bound session needs the open plan of a projection candidate."
    )
  }
  const opened = planCommit(plan)
  if (opened.commitId !== header.commit.id || opened.committedAt !== header.commit.committedAt) {
    throw new MaterializationValidationError(
      "A plan-bound session must begin with the commit its plan carries."
    )
  }
  if (
    (await unplannedCount(sql, candidate.version_id)) > 0 ||
    (await committedSince(sql, candidate.version_id, header.commit.projectId))
  ) {
    throw new MaterializationValidationError(
      "A replacement plan applies only fully planned and just refreshed."
    )
  }
  return { versionId: candidate.version_id, projectionKind: candidate.projection_kind }
}

/**
 * Every identity the plan decides with a diff is classified, and nothing else is. Staging records
 * whether an identity's work holds its classification, so this reads identities only.
 */
export async function assertReplacementPlanCoverage(
  sql: SQLClient,
  plan: PgReplacementPlan
): Promise<void> {
  const [mismatch] = await sql`
    SELECT 1 FROM ${sql(IDENTITIES)}
    WHERE version_id = ${plan.versionId}
      AND classified <> (diff_required AND (entity_kind = 'link' OR ${plan.projectionKind === "object"}))
    LIMIT 1
  `
  if (mismatch) {
    invalidCorrelation("Projection replacement classification coverage does not match its plan.")
  }
}

/** The change counts of a plan, from what its identities planned. */
export async function replacementPlanCounts(
  sql: SQLClient,
  versionId: string
): Promise<EffectiveChangeCounts> {
  const rows = await sql<
    {
      readonly entity_kind: "object" | "link"
      readonly change: "created" | "updated" | "deleted" | "unchanged"
      readonly count: number | string
    }[]
  >`
    SELECT entity_kind, COALESCE(change, 'unchanged') AS change, COUNT(*) AS count
    FROM ${sql(IDENTITIES)}
    WHERE version_id = ${versionId} AND classified
    GROUP BY entity_kind, COALESCE(change, 'unchanged')
  `
  const count = (kind: "object" | "link", change: string) =>
    Number(rows.find((row) => row.entity_kind === kind && row.change === change)?.count ?? 0)
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

/**
 * Whether a commit of the project that this transaction sees is missing from the plan's watermark
 * snapshot. Transaction ids only order commits of one cluster: after a logical restore into
 * another, restored ids may lie ahead of this one's, and a restored plan's watermark too. Neither
 * ever reads as fresh: a commit this snapshot does not see counts for nothing, and a watermark
 * from beyond it counts as stale, so `refresh` checks every revision and resets it.
 */
async function committedSince(sql: SQLClient, versionId: string, projectId: string) {
  const [row] = await sql<{ readonly committed: boolean }[]>`
    SELECT pg_snapshot_xmax(plans.watermark) > pg_snapshot_xmax(pg_current_snapshot()) OR EXISTS (
      SELECT 1 FROM ontology_commits AS commits
      WHERE commits.project_id = ${projectId}
        AND commits.xact_id >= pg_snapshot_xmin(plans.watermark)
        AND NOT pg_visible_in_snapshot(commits.xact_id, plans.watermark)
        AND pg_visible_in_snapshot(commits.xact_id, pg_current_snapshot())
    ) AS committed
    FROM ontology_replacement_plans AS plans
    WHERE plans.version_id = ${versionId}
  `
  return row?.committed ?? true
}

async function readPage(
  sql: SQLClient,
  input: StreamReplacementPlanStateInput,
  candidate: PgOntologySourceRow,
  rows: readonly IdentityRow[]
): Promise<ReplacementPlanStatePage> {
  const reader = new PgMaterializationStateReader(sql, input.projectId)
  if (input.entityKind === "object") {
    const refs = rows.map((row) => {
      const [objectTypeId, primaryId] = JSON.parse(row.identity_key) as string[]
      return { objectTypeId: objectTypeId!, primaryId: primaryId! }
    })
    return {
      objects: await reader.replacementObjectStates(
        input.source.projectionId,
        input.materializationId,
        refs
      ),
      links: [],
      endpoints: [],
    }
  }
  const identities = rows.map((row) => {
    const parts = JSON.parse(row.identity_key) as string[]
    const ref: OntologyLinkRef = {
      source: { objectTypeId: parts[0]!, primaryId: parts[1]! },
      linkId: parts[2]!,
      target: { objectTypeId: parts[3]!, primaryId: parts[4]! },
    }
    return { ref, sortKey: row.sort_key, diffRequired: row.diff_required }
  })
  const [previous] = await sql<{ readonly materialization_id: string }[]>`
    SELECT materialization_id FROM ontology_sources
    WHERE project_id = ${input.projectId} AND source_id = ${input.source.projectionId}
      AND status = 'active'
  `
  const links = await reader.replacementLinkStates(
    input.source.projectionId,
    input.materializationId,
    [input.materializationId, ...(previous ? [previous.materialization_id] : [])],
    identities,
    candidate.base_materialization_id !== null
  )
  return {
    objects: [],
    links,
    endpoints: await endpoints(
      sql,
      candidate.version_id,
      input.projectId,
      identities.flatMap(({ ref }) => [ref.source, ref.target])
    ),
  }
}

/** Planned existence where the plan decides an endpoint, effective existence elsewhere. */
async function endpoints(
  sql: SQLClient,
  versionId: string,
  projectId: string,
  refs: readonly OntologyObjectRef[]
): Promise<MaterializationObjectExistence[]> {
  const unique = [...new Map(refs.map((ref) => [objectRefKey(ref), ref] as const)).values()]
  const rows = await sql<{ readonly key: string; readonly exists: boolean }[]>`
    SELECT requested.key, COALESCE(
      (SELECT (payload->>'exists')::boolean FROM ${sql(PG_PLAN_WORK_TABLE)}
        WHERE work_id = ${versionId} AND unique_key = 'object-existence:' || requested.key),
      EXISTS (
        SELECT 1 FROM objects
        WHERE project_id = ${projectId} AND object_type_id = requested.key::jsonb->>0
          AND primary_id = requested.key::jsonb->>1
      )
    ) AS exists
    FROM unnest(${sql.array(unique.map((ref) => objectRefKey(ref)))}::text[]) AS requested(key)
  `
  const existence = new Map(rows.map((row) => [row.key, row.exists] as const))
  return unique.map((ref) => ({ ref, exists: existence.get(objectRefKey(ref)) ?? false }))
}

/**
 * Adds the links the plan must decide besides its own: those incident to an object it flips,
 * and every member of a scope it changes. Returns how many identities this left to plan,
 * counting an existing member that now needs a diff.
 */
async function expandLinks(sql: SQLClient, versionId: string, projectId: string): Promise<number> {
  const live = liveSourceRowsJoin(sql, projectId)
  const linkKey = sql.unsafe(
    keyExpression(["source_type_id", "source_id", "link_id", "target_type_id", "target_id"])
  )
  const incident = await sql`
    WITH incident_objects AS (
      SELECT DISTINCT payload->'ref'->>'objectTypeId' AS object_type_id,
        payload->'ref'->>'primaryId' AS primary_id
      FROM ${sql(PG_PLAN_WORK_TABLE)}
      WHERE work_id = ${versionId} AND kind = 'incident-object'
    ), incident_links AS (
      SELECT links.source_type_id, links.source_id, links.link_id,
        links.target_type_id, links.target_id
      FROM links JOIN incident_objects
        ON incident_objects.object_type_id = links.source_type_id
       AND incident_objects.primary_id = links.source_id
      WHERE links.project_id = ${projectId}
      UNION
      SELECT links.source_type_id, links.source_id, links.link_id,
        links.target_type_id, links.target_id
      FROM links JOIN incident_objects
        ON incident_objects.object_type_id = links.target_type_id
       AND incident_objects.primary_id = links.target_id
      WHERE links.project_id = ${projectId}
      UNION
      SELECT overrides.source_type_id, overrides.source_primary_id, overrides.link_id,
        overrides.target_type_id, overrides.target_primary_id
      FROM ontology_link_overrides AS overrides JOIN incident_objects
        ON incident_objects.object_type_id = overrides.source_type_id
       AND incident_objects.primary_id = overrides.source_primary_id
      WHERE overrides.project_id = ${projectId}
      UNION
      SELECT overrides.source_type_id, overrides.source_primary_id, overrides.link_id,
        overrides.target_type_id, overrides.target_primary_id
      FROM ontology_link_overrides AS overrides JOIN incident_objects
        ON incident_objects.object_type_id = overrides.target_type_id
       AND incident_objects.primary_id = overrides.target_primary_id
      WHERE overrides.project_id = ${projectId}
      UNION
      SELECT rows.source_type_id, rows.source_primary_id, rows.link_id,
        rows.target_type_id, rows.target_primary_id
      FROM ontology_source_rows AS rows ${live}
      JOIN incident_objects
        ON incident_objects.object_type_id = rows.source_type_id
       AND incident_objects.primary_id = rows.source_primary_id
      WHERE rows.entity_kind = 'link'
      UNION
      SELECT rows.source_type_id, rows.source_primary_id, rows.link_id,
        rows.target_type_id, rows.target_primary_id
      FROM ontology_source_rows AS rows ${live}
      JOIN incident_objects
        ON incident_objects.object_type_id = rows.target_type_id
       AND incident_objects.primary_id = rows.target_primary_id
      WHERE rows.entity_kind = 'link'
    ), keyed AS (
      SELECT ${linkKey} AS identity_key FROM incident_links
    )
    INSERT INTO ${sql(IDENTITIES)} AS identities (
      version_id, entity_kind, identity_key, sort_key, diff_required
    )
    SELECT ${versionId}, 'link', identity_key, ${sql.unsafe(SORT_KEY)}, TRUE
    FROM keyed
    ON CONFLICT (version_id, entity_kind, identity_key) DO UPDATE
    SET diff_required = TRUE, read_revision = NULL, planned_revision = NULL, classified = FALSE,
      change = NULL
    WHERE NOT identities.diff_required
  `
  // An upgraded member planned without a diff keeps no work from before.
  if (incident.count > 0) await dropUnplannedWork(sql, versionId, "link")
  const members = await sql`
    WITH scopes AS (
      SELECT DISTINCT identity_key::jsonb->>0 AS source_type_id,
        identity_key::jsonb->>1 AS source_id, identity_key::jsonb->>2 AS link_id
      FROM ${sql(IDENTITIES)}
      WHERE version_id = ${versionId} AND entity_kind = 'link' AND diff_required
    ), members AS (
      SELECT links.source_type_id, links.source_id, links.link_id,
        links.target_type_id, links.target_id
      FROM links JOIN scopes USING (source_type_id, source_id, link_id)
      WHERE links.project_id = ${projectId}
      UNION
      SELECT overrides.source_type_id, overrides.source_primary_id, overrides.link_id,
        overrides.target_type_id, overrides.target_primary_id
      FROM ontology_link_overrides AS overrides JOIN scopes
        ON scopes.source_type_id = overrides.source_type_id
       AND scopes.source_id = overrides.source_primary_id
       AND scopes.link_id = overrides.link_id
      WHERE overrides.project_id = ${projectId} AND overrides.identity_kind = 'slot'
    ), keyed AS (
      SELECT ${linkKey} AS identity_key FROM members
    )
    INSERT INTO ${sql(IDENTITIES)} (version_id, entity_kind, identity_key, sort_key, diff_required)
    SELECT ${versionId}, 'link', identity_key, ${sql.unsafe(SORT_KEY)}, FALSE
    FROM keyed
    ON CONFLICT (version_id, entity_kind, identity_key) DO NOTHING
  `
  return incident.count + members.count
}

async function analyzePlans(sql: SQLClient): Promise<void> {
  await sql`ANALYZE ${sql(IDENTITIES)}, ${sql(PG_PLAN_WORK_TABLE)}`
}

/** Deletes the work of the identities of `kind` left to plan: an identity to plan holds none. */
async function dropUnplannedWork(
  sql: SQLClient,
  versionId: string,
  kind: "object" | "link"
): Promise<void> {
  await sql`
    DELETE FROM ${sql(PG_PLAN_WORK_TABLE)} AS work USING ${sql(IDENTITIES)} AS identities
    WHERE work.work_id = ${versionId} AND work.entity_kind = ${kind}
      AND identities.version_id = ${versionId} AND identities.entity_kind = ${kind}
      AND identities.planned_revision IS NULL AND identities.identity_key = work.identity_key
  `
}

async function unplannedCount(
  sql: SQLClient,
  versionId: string,
  kind?: "object" | "link"
): Promise<number> {
  const [row] = await sql<{ readonly count: number | string }[]>`
    SELECT COUNT(*) AS count FROM ${sql(IDENTITIES)}
    WHERE version_id = ${versionId} AND planned_revision IS NULL
      ${kind ? sql`AND entity_kind = ${kind}` : sql``}
  `
  return Number(row?.count ?? 0)
}

async function requireCandidate(
  sql: SQLClient,
  input: ReplacementPlanRef,
  lock = false
): Promise<PgOntologySourceRow> {
  const candidate = await sourceRow(
    sql,
    input.projectId,
    input.source.projectionId,
    input.materializationId,
    lock
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
  await assertProjectionExecution(sql, {
    projectId: input.projectId,
    sourceId: input.source.projectionId,
    projectionRunId: input.execution.projectionRunId,
    executionToken: input.execution.executionToken,
  })
  return candidate
}

async function requirePlan(
  sql: SQLClient,
  input: ReplacementPlanRef
): Promise<{ readonly plan: PlanRow; readonly candidate: PgOntologySourceRow }> {
  const candidate = await requireCandidate(sql, input)
  const plan = await planRow(sql, candidate.version_id)
  if (!plan) {
    throw new MaterializationConflictError(
      "source-materialization",
      `Candidate source materialization '${input.materializationId}' has no open plan.`
    )
  }
  return { plan, candidate }
}

async function deletePlan(sql: SQLClient, versionId: string): Promise<void> {
  await sql`DELETE FROM ${sql(PG_PLAN_WORK_TABLE)} WHERE work_id = ${versionId}`
  await sql`DELETE FROM ${sql(IDENTITIES)} WHERE version_id = ${versionId}`
  await sql`DELETE FROM ontology_replacement_plans WHERE version_id = ${versionId}`
}

async function planRow(sql: SQLClient, versionId: string): Promise<PlanRow | null> {
  const [row] = await sql<PlanRow[]>`
    SELECT version_id, commit_id, committed_at, replaced_materialization_id,
      replaced_last_commit_id
    FROM ontology_replacement_plans
    WHERE version_id = ${versionId}
  `
  return row ?? null
}

/** The commit a plan was opened with, as its staged work and its session must carry it. */
function planCommit(plan: PlanRow) {
  return { commitId: plan.commit_id, committedAt: toIsoString(plan.committed_at) }
}

async function sourceRow(
  sql: SQLClient,
  projectId: string,
  sourceId: string,
  materializationId: string,
  lock = false
): Promise<PgOntologySourceRow | null> {
  const [row] = await sql<PgOntologySourceRow[]>`
    SELECT * FROM ontology_sources
    WHERE project_id = ${projectId} AND source_id = ${sourceId}
      AND materialization_id = ${materializationId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `
  return row ?? null
}

/** The canonical JSON key of a row's identity columns, as `objectRefKey`/`linkRefKey` render it. */
function keyExpression(columns: readonly string[]): string {
  return jsonTupleExpression(columns.map((column) => `to_jsonb(${column})::text`))
}
