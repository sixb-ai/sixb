import type {
  CompiledConditionalObjectReadScope,
  CompiledSelectedObjectReadScope,
} from "@sixb/core/storage"
import {
  type CompiledPgObjectQuery,
  compilePgObjectStatement,
  type PgObjectQuerySource,
} from "./query-compiler"
import { compilePgConditionFilter } from "./visibility"

export interface PgSelectedObjectReadSource extends PgObjectQuerySource {
  readonly objectPropertyPermissionsTable: string
  readonly traversalProbe: {
    readonly sql: string
    readonly args: readonly unknown[]
  }
}

/**
 * Prepare one immutable selected scope as live, path-sensitive PostgreSQL relations.
 *
 * The complete compiled scope is serialized once. Every statement receives that one JSONB
 * document and the bound project id, keeping the parameter count constant as selections grow.
 * Group property grants after resolving paths so redaction reads only each object's own grants.
 */
export function compilePgSelectedObjectReadSource(
  projectId: string,
  scope: CompiledSelectedObjectReadScope,
  maxTraversalFacts: number
): PgSelectedObjectReadSource {
  const scopeJson = JSON.stringify({
    roots: scope.roots,
    objects: scope.objects,
    steps: scope.steps,
  })
  const relations = compileSelectedReadScopeCte(scopeJson, projectId)
  const source: PgSelectedObjectReadSource = {
    ...scopedQuerySource(() => relations),
    objectPropertyPermissionsTable: "_sixb_scope_object_permissions",
    traversalProbe: { sql: "", args: [] },
  }

  const traversalProbe = compilePgObjectStatement(
    `
      SELECT COUNT(*)::bigint AS total
      FROM (
        SELECT 1 AS traversal_fact
        FROM _sixb_scope_root_facts

        UNION ALL

        SELECT 1 AS traversal_fact
        FROM _sixb_scope_reached_links

        LIMIT ?
      ) AS bounded_traversal_facts
    `,
    [BigInt(maxTraversalFacts) + 1n],
    source
  )

  return Object.freeze({ ...source, traversalProbe })
}

/**
 * Prepare a conditional scope as PostgreSQL relations that filter stored rows as they are read.
 *
 * Both relations are NOT MATERIALIZED, so PostgreSQL inlines them into each statement: its
 * filters, index scans and LIMIT reach the stored tables, and the conditions become one more
 * filter. An object of a conditioned type is visible while its condition matches; a link while
 * each of its conditioned endpoints is a visible object.
 */
export function compilePgConditionalObjectReadSource(
  projectId: string,
  scope: CompiledConditionalObjectReadScope
): PgObjectQuerySource {
  const filters = new Map(
    scope.conditions.map((condition) => [condition.objectTypeId, compilePgConditionFilter(condition)])
  )

  const relations = compileConditionalReadScopeRelations(projectId, filters)

  return Object.freeze({
    ...scopedQuerySource((sql) => withReadRelations(relations, sql)),
    // A link is visible while both endpoints are, so a statement that reads both through
    // `_sixb_scope_objects` reads stored links. Checking each endpoint again plans every partition
    // of objects: the endpoint's type comes from the link row, so PostgreSQL cannot prune them.
    linksBetweenVisibleObjectsTable: "links",
    // One type's visible objects are the stored ones its own condition matches.
    objectsOfType: (objectTypeId: string) => {
      const filter = filters.get(objectTypeId)
      return filter ? { table: "objects", filter } : { table: "objects" }
    },
  })
}

interface CompiledReadScopeCte {
  readonly sql: string
  readonly args: readonly unknown[]
}

/** Prefix every statement of a query with the scope's relations, ahead of its own arguments. */
function scopedQuerySource(
  withClause: (statementSql: string) => CompiledReadScopeCte
): PgObjectQuerySource {
  const wrapStatement = (sql: string, args: readonly unknown[] = []) => {
    const compiled = withClause(sql)
    return {
      sql: `${compiled.sql}\n${sql}`,
      args: [...compiled.args, ...args],
    }
  }

  return {
    objectsTable: "_sixb_scope_objects",
    linksTable: "_sixb_scope_links",
    wrapStatement,
    wrapQuery: (query: CompiledPgObjectQuery): CompiledPgObjectQuery => {
      const total = wrapStatement(query.totalSql, query.totalArgs)

      return {
        ...query,
        ...wrapStatement(query.sql, query.args),
        vectorProbe: query.vectorProbe
          ? {
              ...query.vectorProbe,
              ...wrapStatement(query.vectorProbe.sql, query.vectorProbe.args),
            }
          : undefined,
        totalSql: total.sql,
        totalArgs: total.args,
        ...(query.hasMoreProbe
          ? {
              hasMoreProbe: {
                ...query.hasMoreProbe,
                ...wrapStatement(query.hasMoreProbe.sql, query.hasMoreProbe.args),
              },
            }
          : {}),
      }
    },
  }
}

interface ReadRelation extends CompiledReadScopeCte {
  readonly name: string
}

/**
 * The WITH clause naming the relations a statement reads. PostgreSQL parses and analyzes every
 * relation a WITH clause names, read or not, and each one repeats every condition.
 */
function withReadRelations(
  relations: readonly ReadRelation[],
  statementSql: string
): CompiledReadScopeCte {
  const read = relations.filter((relation) =>
    new RegExp(`\\b${relation.name}\\b`).test(statementSql)
  )
  if (read.length === 0) return { sql: "", args: [] }

  return {
    sql: `WITH ${read.map((relation) => relation.sql).join(",\n")}`,
    args: read.flatMap((relation) => relation.args),
  }
}

/** Conditions keyed by their concrete type, each compiled over that type's `properties`. */
type ConditionFilters = ReadonlyMap<
  string,
  { readonly sql: string; readonly args: readonly unknown[] }
>

function compileConditionalReadScopeRelations(
  projectId: string,
  filters: ConditionFilters
): readonly ReadRelation[] {
  if (filters.size === 0) {
    return [
      {
        name: "_sixb_scope_objects",
        sql: `
          _sixb_scope_objects AS NOT MATERIALIZED (
            SELECT * FROM objects WHERE project_id = ?
          )
        `,
        args: [projectId],
      },
      {
        name: "_sixb_scope_links",
        sql: `
          _sixb_scope_links AS NOT MATERIALIZED (
            SELECT * FROM links WHERE project_id = ?
          )
        `,
        args: [projectId],
      },
    ]
  }

  const conditionedTypeArgs = [...filters.keys()]
  const conditionedTypes = conditionedTypeArgs.map(() => "?::text").join(", ")

  const matches: string[] = []
  const matchArgs: unknown[] = []
  for (const [objectTypeId, filter] of filters) {
    matches.push(`(object_type_id = ?::text AND ${filter.sql})`)
    matchArgs.push(objectTypeId, ...filter.args)
  }

  // An endpoint of a conditioned type is a visible object of that type. Each check names its type,
  // so PostgreSQL plans that type's partition alone: matched on the link row's type, one check
  // would plan every partition of objects.
  const visibleEndpoint = (end: "source" | "target"): CompiledReadScopeCte => {
    const checks: string[] = []
    const args: unknown[] = [...conditionedTypeArgs]

    for (const [objectTypeId, filter] of filters) {
      checks.push(`
        (
          stored.${end}_type_id = ?::text
          AND EXISTS (
            SELECT 1
            FROM objects AS endpoint
            WHERE endpoint.project_id = stored.project_id
              AND endpoint.object_type_id = ?::text
              AND endpoint.primary_id = stored.${end}_id
              AND (${filter.sql})
          )
        )
      `)
      args.push(objectTypeId, objectTypeId, ...filter.args)
    }

    return {
      sql: `(stored.${end}_type_id NOT IN (${conditionedTypes}) OR ${checks.join(" OR ")})`,
      args,
    }
  }
  const visibleSource = visibleEndpoint("source")
  const visibleTarget = visibleEndpoint("target")

  return [
    {
      name: "_sixb_scope_objects",
      sql: `
        _sixb_scope_objects AS NOT MATERIALIZED (
          SELECT *
          FROM objects
          WHERE project_id = ?
            AND (object_type_id NOT IN (${conditionedTypes}) OR ${matches.join(" OR ")})
        )
      `,
      args: [projectId, ...conditionedTypeArgs, ...matchArgs],
    },
    {
      name: "_sixb_scope_links",
      sql: `
        _sixb_scope_links AS NOT MATERIALIZED (
          SELECT stored.*
          FROM links AS stored
          WHERE stored.project_id = ?
            AND ${visibleSource.sql}
            AND ${visibleTarget.sql}
        )
      `,
      args: [projectId, ...visibleSource.args, ...visibleTarget.args],
    },
  ]
}

function compileSelectedReadScopeCte(scopeJson: string, projectId: string): CompiledReadScopeCte {
  return {
    sql: `
      WITH RECURSIVE
      _sixb_scope_document(scope) AS (
        SELECT ?::text::jsonb
      ),
      _sixb_scope_roots(root_id, node_id, object_type_id, primary_id) AS (
        SELECT
          (root.ordinality - 1)::integer,
          (root.value ->> 'nodeId')::integer,
          root.value ->> 'objectTypeId',
          root.value ->> 'primaryId'
        FROM _sixb_scope_document AS document
        CROSS JOIN LATERAL jsonb_array_elements(document.scope -> 'roots')
          WITH ORDINALITY AS root(value, ordinality)
      ),
      _sixb_scope_root_facts(project_id, root_id, node_id, object_type_id, primary_id) AS (
        SELECT anchor.project_id, root.root_id, root.node_id, root.object_type_id, root.primary_id
        FROM _sixb_scope_roots AS root
        JOIN objects AS anchor
          ON anchor.project_id = ?
         AND anchor.object_type_id = root.object_type_id
         AND anchor.primary_id = root.primary_id
      ),
      _sixb_scope_object_selections(node_id, object_type_id, property_ids) AS (
        SELECT
          (selection.value ->> 'nodeId')::integer,
          selection.value ->> 'objectTypeId',
          selection.value -> 'propertyIds'
        FROM _sixb_scope_document AS document
        CROSS JOIN LATERAL jsonb_array_elements(document.scope -> 'objects') AS selection(value)
      ),
      _sixb_scope_link_selections(
        step_id,
        node_id,
        parent_node_id,
        source_object_type_id,
        link_id,
        target_object_type_id,
        property_ids
      ) AS (
        SELECT
          (step.ordinality - 1)::integer,
          (step.value ->> 'nodeId')::integer,
          (step.value ->> 'parentNodeId')::integer,
          step.value ->> 'sourceObjectTypeId',
          step.value ->> 'linkId',
          step.value ->> 'targetObjectTypeId',
          step.value -> 'propertyIds'
        FROM _sixb_scope_document AS document
        CROSS JOIN LATERAL jsonb_array_elements(document.scope -> 'steps')
          WITH ORDINALITY AS step(value, ordinality)
      ),
      _sixb_scope_reachable(project_id, node_id, object_type_id, primary_id) AS (
        SELECT root.project_id, root.node_id, root.object_type_id, root.primary_id
        FROM _sixb_scope_root_facts AS root

        UNION

        SELECT edge.project_id, selection.node_id, edge.target_type_id, edge.target_id
        FROM _sixb_scope_reachable AS parent
        JOIN _sixb_scope_link_selections AS selection
          ON selection.parent_node_id = parent.node_id
         AND selection.source_object_type_id = parent.object_type_id
        JOIN links AS edge
          ON edge.project_id = parent.project_id
         AND edge.source_type_id = parent.object_type_id
         AND edge.source_id = parent.primary_id
         AND edge.link_id = selection.link_id
         AND edge.target_type_id = selection.target_object_type_id
        JOIN objects AS target
          ON target.project_id = edge.project_id
         AND target.object_type_id = edge.target_type_id
         AND target.primary_id = edge.target_id
      ),
      _sixb_scope_object_permissions(project_id, object_type_id, primary_id, property_id) AS (
        SELECT DISTINCT
          reachable.project_id,
          reachable.object_type_id,
          reachable.primary_id,
          selected_property.value
        FROM _sixb_scope_reachable AS reachable
        JOIN _sixb_scope_object_selections AS selection
          ON selection.node_id = reachable.node_id
         AND selection.object_type_id = reachable.object_type_id
        CROSS JOIN LATERAL jsonb_array_elements_text(selection.property_ids)
          AS selected_property(value)
      ),
      _sixb_scope_object_ids(project_id, object_type_id, primary_id) AS (
        SELECT DISTINCT project_id, object_type_id, primary_id
        FROM _sixb_scope_reachable
      ),
      _sixb_scope_object_grants AS (
        SELECT reachable.project_id, reachable.object_type_id, reachable.primary_id,
          array_agg(DISTINCT selected_property.value) FILTER (WHERE selected_property.value IS NOT NULL) AS property_ids
        FROM _sixb_scope_reachable AS reachable
        LEFT JOIN _sixb_scope_object_selections AS selection
          ON selection.node_id = reachable.node_id
         AND selection.object_type_id = reachable.object_type_id
        LEFT JOIN LATERAL jsonb_array_elements_text(selection.property_ids) AS selected_property(value) ON true
        GROUP BY reachable.project_id, reachable.object_type_id, reachable.primary_id
      ),
      _sixb_scope_objects AS (
        SELECT stored.project_id, stored.object_type_id, stored.primary_id,
          COALESCE((
            SELECT jsonb_object_agg(property.key, property.value)
            FROM jsonb_each(stored.properties) AS property(key, value)
            WHERE property.key = ANY(grants.property_ids)
          ), '{}'::jsonb) AS properties,
          stored.created_at, stored.updated_at, stored.version, stored.last_commit_id
        FROM _sixb_scope_object_grants AS grants
        JOIN objects AS stored
          ON stored.project_id = grants.project_id
         AND stored.object_type_id = grants.object_type_id
         AND stored.primary_id = grants.primary_id
      ),
      _sixb_scope_reached_links(
        project_id,
        step_id,
        node_id,
        parent_node_id,
        source_type_id,
        source_id,
        link_id,
        target_type_id,
        target_id,
        property_ids
      ) AS (
        SELECT
          edge.project_id,
          selection.step_id,
          selection.node_id,
          selection.parent_node_id,
          edge.source_type_id,
          edge.source_id,
          edge.link_id,
          edge.target_type_id,
          edge.target_id,
          selection.property_ids
        FROM _sixb_scope_reachable AS parent
        JOIN _sixb_scope_link_selections AS selection
          ON selection.parent_node_id = parent.node_id
         AND selection.source_object_type_id = parent.object_type_id
        JOIN links AS edge
          ON edge.project_id = parent.project_id
         AND edge.source_type_id = parent.object_type_id
         AND edge.source_id = parent.primary_id
         AND edge.link_id = selection.link_id
         AND edge.target_type_id = selection.target_object_type_id
        JOIN objects AS target
          ON target.project_id = edge.project_id
         AND target.object_type_id = edge.target_type_id
         AND target.primary_id = edge.target_id
      ),
      _sixb_scope_link_permissions(
        project_id,
        source_type_id,
        source_id,
        link_id,
        target_type_id,
        target_id,
        property_id
      ) AS (
        SELECT DISTINCT
          reached.project_id,
          reached.source_type_id,
          reached.source_id,
          reached.link_id,
          reached.target_type_id,
          reached.target_id,
          selected_property.value
        FROM _sixb_scope_reached_links AS reached
        CROSS JOIN LATERAL jsonb_array_elements_text(reached.property_ids)
          AS selected_property(value)
      ),
      _sixb_scope_link_ids(
        project_id,
        source_type_id,
        source_id,
        link_id,
        target_type_id,
        target_id
      ) AS (
        SELECT DISTINCT
          project_id,
          source_type_id,
          source_id,
          link_id,
          target_type_id,
          target_id
        FROM _sixb_scope_reached_links
      ),
      _sixb_scope_links AS (
        SELECT
          stored.project_id,
          stored.source_type_id,
          stored.source_id,
          stored.link_id,
          stored.target_type_id,
          stored.target_id,
          CASE
            WHEN stored.properties IS NULL THEN NULL
            ELSE NULLIF(
              (
                SELECT jsonb_object_agg(property.key, property.value)
                FROM jsonb_each(stored.properties) AS property(key, value)
                JOIN _sixb_scope_link_permissions AS permission
                  ON permission.project_id = stored.project_id
                 AND permission.source_type_id = stored.source_type_id
                 AND permission.source_id = stored.source_id
                 AND permission.link_id = stored.link_id
                 AND permission.target_type_id = stored.target_type_id
                 AND permission.target_id = stored.target_id
                 AND permission.property_id = property.key
              ),
              '{}'::jsonb
            )
          END AS properties,
          stored.created_at,
          stored.updated_at,
          stored.last_commit_id
        FROM links AS stored
        JOIN _sixb_scope_link_ids AS visible
          ON visible.project_id = stored.project_id
         AND visible.source_type_id = stored.source_type_id
         AND visible.source_id = stored.source_id
         AND visible.link_id = stored.link_id
         AND visible.target_type_id = stored.target_type_id
         AND visible.target_id = stored.target_id
      )
    `,
    args: [scopeJson, projectId],
  }
}
