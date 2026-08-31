import type { CompiledSelectedObjectReadScope } from "@sixb/core/storage"
import {
  type CompiledPgObjectQuery,
  compilePgObjectStatement,
  type PgObjectQuerySource,
} from "./pg-object-query-compiler"

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
  const compiled = compileSelectedReadScopeCte(scopeJson, projectId)
  const wrapStatement = (sql: string, args: readonly unknown[] = []) => ({
    sql: `${compiled.sql}\n${sql}`,
    args: [...compiled.args, ...args],
  })

  const source: PgSelectedObjectReadSource = {
    objectsTable: "_sixb_scope_objects",
    linksTable: "_sixb_scope_links",
    objectPropertyPermissionsTable: "_sixb_scope_object_permissions",
    wrapStatement,
    wrapQuery: (query: CompiledPgObjectQuery): CompiledPgObjectQuery => ({
      ...query,
      ...wrapStatement(query.sql, query.args),
      totalSql: `${compiled.sql}\n${query.totalSql}`,
      totalArgs: [...compiled.args, ...query.totalArgs],
      ...(query.hasMoreProbe
        ? {
            hasMoreProbe: {
              ...query.hasMoreProbe,
              ...wrapStatement(query.hasMoreProbe.sql, query.hasMoreProbe.args),
            },
          }
        : {}),
    }),
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

interface CompiledReadScopeCte {
  readonly sql: string
  readonly args: readonly unknown[]
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
      _sixb_scope_objects AS (
        SELECT
          stored.project_id,
          stored.object_type_id,
          stored.primary_id,
          COALESCE(
            (
              SELECT jsonb_object_agg(property.key, property.value)
              FROM jsonb_each(stored.properties) AS property(key, value)
              JOIN _sixb_scope_object_permissions AS permission
                ON permission.project_id = stored.project_id
               AND permission.object_type_id = stored.object_type_id
               AND permission.primary_id = stored.primary_id
               AND permission.property_id = property.key
            ),
            '{}'::jsonb
          ) AS properties,
          stored.created_at,
          stored.updated_at,
          stored.version,
          stored.last_commit_id
        FROM objects AS stored
        JOIN _sixb_scope_object_ids AS visible
          ON visible.project_id = stored.project_id
         AND visible.object_type_id = stored.object_type_id
         AND visible.primary_id = stored.primary_id
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
