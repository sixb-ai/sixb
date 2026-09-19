import { projectionEntityKey } from "../../packages/core/src/materialization/refs"
import { utf8SortKey } from "../../packages/core/src/storage/ontology/provider"

/** Pre-incremental snapshots: one object root owns both an object and an FK assertion. */
export function legacySourceFixture(): string {
  const root = { kind: "object" as const, ref: { objectTypeId: "Device", primaryId: "a" } }
  const link = {
    kind: "link" as const,
    ref: { source: root.ref, linkId: "parent", target: { objectTypeId: "Device", primaryId: "b" } },
  }
  const key = projectionEntityKey(root)
  const sortKey = utf8SortKey(key)
  const at = "2026-01-01T00:00:00.000Z"
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const statements: string[] = []
  for (const status of ["staging", "ready", "active", "superseded", "abandoned"]) {
    const published = status === "active" || status === "superseded"
    const terminal = status === "superseded" || status === "abandoned"
    const staging = status === "staging"
    statements.push(`INSERT INTO ontology_sources (
      project_id, source_id, materialization_id, projection_run_id, projection_kind, protocol,
      status, execution_token, dataset_id, dataset_version_id, dataset_version_created_at,
      projection_revision, ownership_hash, ontology_revision, root_count, assertion_count,
      created_at, ready_at, activated_at, terminal_at, last_commit_id, updated_at
    ) VALUES ('p','source','${status}','run-${status}','object','replacement','${status}',
      ${staging || status === "ready" ? "'token'" : "NULL"},'dataset','${status}','${at}',
      'revision','ownership','ontology',${staging ? "NULL,NULL" : "1,2"},'${at}',
      ${staging ? "NULL" : quote(at)},${published ? quote(at) : "NULL"},
      ${terminal ? quote(at) : "NULL"},${published ? "'commit'" : "NULL"},'${at}');`)
    statements.push(`INSERT INTO ontology_source_rows (
      project_id, source_id, materialization_id, entity_kind, entity_key, entity_sort_key,
      root_kind, root_key, root_sort_key, staging_ordinal, root, assertion,
      object_type_id, primary_id, root_object_type_id, root_primary_id
    ) VALUES ('p','source','${status}','object',${quote(key)},'${sortKey}',
      'object',${quote(key)},'${sortKey}',0,${quote(JSON.stringify(root))},
      ${quote(JSON.stringify({ ...root, properties: { id: "a", name: status } }))},
      'Device','a','Device','a');`)
    statements.push(`INSERT INTO ontology_source_rows (
      project_id, source_id, materialization_id, entity_kind, entity_key, entity_sort_key,
      root_kind, root_key, root_sort_key, staging_ordinal, root, assertion,
      source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
      root_object_type_id, root_primary_id
    ) VALUES ('p','source','${status}','link',${quote(projectionEntityKey(link))},
      '${utf8SortKey(projectionEntityKey(link))}','object',${quote(key)},'${sortKey}',0,
      ${quote(JSON.stringify(root))},${quote(JSON.stringify(link))},
      'Device','a','parent','Device','b','Device','a');`)
  }
  return statements.join("\n")
}
