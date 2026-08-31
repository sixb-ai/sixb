import type { CompiledSelectedObjectReadScope } from "@sixb/core/storage"
import {
  type CompiledObjectQuery,
  type SqliteObjectQuerySource,
  type SqliteValue,
  sqliteJsonEachValue,
} from "./object-query-compiler"

export interface SqliteSelectedObjectReadSource extends SqliteObjectQuerySource {
  readonly objectPropertyPermissionsTable: string
  readonly traversalProbe: {
    readonly sql: string
    readonly args: readonly SqliteValue[]
  }
}

/**
 * Prepare one immutable selected scope as live, path-sensitive SQLite relations.
 *
 * The complete compiled scope is serialized once. Every statement receives that one JSON document
 * and the bound project id, keeping the host-parameter count constant as selections grow.
 */
export function compileSqliteSelectedObjectReadSource(
  projectId: string,
  scope: CompiledSelectedObjectReadScope,
  maxTraversalFacts: number
): SqliteSelectedObjectReadSource {
  const scopeJson = JSON.stringify({
    roots: scope.roots,
    objects: scope.objects,
    steps: scope.steps,
  })
  const compiled = compileSelectedReadScopeCte(scopeJson, projectId)
  const wrapStatement = (sql: string, args: readonly SqliteValue[] = []) => ({
    sql: `${compiled.sql}\n${sql}`,
    args: [...compiled.args, ...args],
  })

  return Object.freeze({
    objectsTable: "_sixb_scope_objects",
    linksTable: "_sixb_scope_links",
    objectPropertyPermissionsTable: "_sixb_scope_object_permissions",
    wrapStatement,
    wrapQuery: (query: CompiledObjectQuery): CompiledObjectQuery => ({
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
    traversalProbe: wrapStatement(
      `
        SELECT COUNT(*) AS total
        FROM (
          SELECT 1 AS traversal_fact
          FROM _sixb_scope_root_facts

          UNION ALL

          SELECT 1 AS traversal_fact
          FROM _sixb_scope_reached_links

          LIMIT ?
        ) AS bounded_traversal_facts
      `,
      [BigInt(maxTraversalFacts) + 1n]
    ),
  })
}

interface CompiledReadScopeCte {
  readonly sql: string
  readonly args: readonly SqliteValue[]
}

function compileSelectedReadScopeCte(scopeJson: string, projectId: string): CompiledReadScopeCte {
  return {
    sql: `
      WITH RECURSIVE
      _sixb_scope_document(scope) AS (
        SELECT json(?)
      ),
      _sixb_scope_roots(root_id, node_id, object_type_id, primary_id) AS (
        SELECT
          CAST(root.key AS INTEGER),
          CAST(json_extract(root.value, '$.nodeId') AS INTEGER),
          CAST(json_extract(root.value, '$.objectTypeId') AS TEXT),
          CAST(json_extract(root.value, '$.primaryId') AS TEXT)
        FROM _sixb_scope_document AS document,
             json_each(json_extract(document.scope, '$.roots')) AS root
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
          CAST(json_extract(selection.value, '$.nodeId') AS INTEGER),
          CAST(json_extract(selection.value, '$.objectTypeId') AS TEXT),
          json_extract(selection.value, '$.propertyIds')
        FROM _sixb_scope_document AS document,
             json_each(json_extract(document.scope, '$.objects')) AS selection
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
          CAST(step.key AS INTEGER),
          CAST(json_extract(step.value, '$.nodeId') AS INTEGER),
          CAST(json_extract(step.value, '$.parentNodeId') AS INTEGER),
          CAST(json_extract(step.value, '$.sourceObjectTypeId') AS TEXT),
          CAST(json_extract(step.value, '$.linkId') AS TEXT),
          CAST(json_extract(step.value, '$.targetObjectTypeId') AS TEXT),
          json_extract(step.value, '$.propertyIds')
        FROM _sixb_scope_document AS document,
             json_each(json_extract(document.scope, '$.steps')) AS step
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
          CAST(selected_property.value AS TEXT)
        FROM _sixb_scope_reachable AS reachable
        JOIN _sixb_scope_object_selections AS selection
          ON selection.node_id = reachable.node_id
         AND selection.object_type_id = reachable.object_type_id
        JOIN json_each(selection.property_ids) AS selected_property
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
              SELECT json_group_object(property.key, ${sqliteJsonEachValue("property")})
              FROM json_each(stored.properties) AS property
              JOIN _sixb_scope_object_permissions AS permission
                ON permission.project_id = stored.project_id
               AND permission.object_type_id = stored.object_type_id
               AND permission.primary_id = stored.primary_id
               AND permission.property_id = property.key
            ),
            json('{}')
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
          CAST(selected_property.value AS TEXT)
        FROM _sixb_scope_reached_links AS reached
        JOIN json_each(reached.property_ids) AS selected_property
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
                SELECT json_group_object(property.key, ${sqliteJsonEachValue("property")})
                FROM json_each(stored.properties) AS property
                JOIN _sixb_scope_link_permissions AS permission
                  ON permission.project_id = stored.project_id
                 AND permission.source_type_id = stored.source_type_id
                 AND permission.source_id = stored.source_id
                 AND permission.link_id = stored.link_id
                 AND permission.target_type_id = stored.target_type_id
                 AND permission.target_id = stored.target_id
                 AND permission.property_id = property.key
              ),
              json('{}')
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
