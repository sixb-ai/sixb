import type {
  ExpandedLinkValue,
  ExpandedObjectRow,
  ObjectLinkRow,
  ObjectRow,
  ObjectRowLinks,
} from "@sixb/core/storage"

export function rowToObject(row: ObjectDatabaseRow): ObjectRow {
  return {
    projectId: row.project_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    properties: row.properties as Record<string, unknown>,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
    lastCommitId: row.last_commit_id,
  }
}

// Map a query row, attaching `links` when an `expand` pushdown produced them. The
// base columns map as usual; `_expand` (a `jsonb_build_object`) is revived into
// the runtime link shape the core executor's fallback also produces.
export function queryRowToObject(row: ObjectQueryDatabaseRow): ObjectRow {
  const base = rowToObject(row)
  const links = reviveExpandedLinks(row._expand)
  return links ? { ...base, links } : base
}

function reviveExpandedLinks(value: unknown): ObjectRowLinks | undefined {
  if (!isPlainRecord(value)) return undefined
  const links: ObjectRowLinks = {}
  for (const [linkId, raw] of Object.entries(value)) {
    links[linkId] = reviveExpandedLinkValue(raw)
  }
  return links
}

// A "one" expansion arrives as a single object or null; a "many" expansion as an
// array (already ordered and trimmed in the database).
function reviveExpandedLinkValue(value: unknown): ExpandedLinkValue {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(reviveExpandedRow)
  return reviveExpandedRow(value)
}

// Revive one hydrated neighbour from `compileExpansionChildJson`: JSONB timestamp
// strings back to `Date`, empty link properties dropped (matching the fallback),
// and nested links recursed.
function reviveExpandedRow(value: unknown): ExpandedObjectRow {
  const row = isPlainRecord(value) ? value : {}
  const expanded: ExpandedObjectRow = {
    projectId: String(row.projectId),
    objectTypeId: String(row.objectTypeId),
    primaryId: String(row.primaryId),
    properties: isPlainRecord(row.properties) ? row.properties : {},
    createdAt: new Date(row.createdAt as string),
    updatedAt: new Date(row.updatedAt as string),
    version: Number(row.version),
    lastCommitId: String(row.lastCommitId),
  }
  if (isPlainRecord(row.linkProperties) && Object.keys(row.linkProperties).length > 0) {
    expanded.linkProperties = row.linkProperties
  }
  const links = reviveExpandedLinks(row.links)
  if (links) expanded.links = links
  return expanded
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function rowToLink(row: LinkDatabaseRow): ObjectLinkRow {
  return {
    projectId: row.project_id,
    sourceTypeId: row.source_type_id,
    sourceId: row.source_id,
    linkId: row.link_id,
    targetTypeId: row.target_type_id,
    targetId: row.target_id,
    ...(row.properties === null ? {} : { properties: row.properties as Record<string, unknown> }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastCommitId: row.last_commit_id,
  }
}

export function linkIdentity(link: ObjectLinkRow): string {
  return JSON.stringify([
    link.sourceTypeId,
    link.sourceId,
    link.linkId,
    link.targetTypeId,
    link.targetId,
  ])
}

export interface ObjectDatabaseRow {
  project_id: string
  object_type_id: string
  primary_id: string
  properties: unknown
  created_at: Date | string
  updated_at: Date | string
  version: number
  last_commit_id: string
}

export interface ObjectQueryDatabaseRow extends ObjectDatabaseRow {
  _cursor_properties?: unknown
  /** `jsonb_build_object(linkId, value, ...)` from an `expand` pushdown; absent otherwise. */
  _expand?: unknown
}

export interface ObjectBatchDatabaseRow extends ObjectDatabaseRow {
  _batch_index: number
}

export interface PropertyPermissionBatchDatabaseRow {
  _batch_index: number
}

export interface FacetDatabaseRow {
  value_type: string | null
  value_text: string | null
  count: string | number | bigint
}

export interface LinkDatabaseRow {
  project_id: string
  source_type_id: string
  source_id: string
  link_id: string
  target_type_id: string
  target_id: string
  properties: unknown | null
  created_at: Date | string
  updated_at: Date | string
  last_commit_id: string
}

export interface LinkBatchDatabaseRow extends LinkDatabaseRow {
  _batch_index: number
}
