import type {
  ExpandedLinkValue,
  ExpandedObjectRow,
  ObjectLinkRow,
  ObjectRow,
  ObjectRowLinks,
} from "@sixb/core/storage"

export function rowToObject(row: DatabaseRow): ObjectRow {
  return {
    projectId: row.project_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    properties: JSON.parse(row.properties),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
    lastCommitId: row.last_commit_id,
  }
}

/** Decode an expanded query row with the same shape as Core link hydration. */
export function queryRowToObject(row: ObjectQueryDatabaseRow): ObjectRow {
  const base = rowToObject(row)
  const links = reviveExpandedLinks(parseExpandColumn(row._expand))
  return links ? { ...base, links } : base
}

export function rowToLink(row: LinkDatabaseRow): ObjectLinkRow {
  return {
    projectId: row.project_id,
    sourceTypeId: row.source_type_id,
    sourceId: row.source_id,
    linkId: row.link_id,
    targetTypeId: row.target_type_id,
    targetId: row.target_id,
    ...(row.properties === null ? {} : { properties: JSON.parse(row.properties) }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastCommitId: row.last_commit_id,
  }
}

// The `_expand` column comes back from SQLite as a JSON string (or null/absent
// when the query carried no expansion); parse it before reviving.
function parseExpandColumn(value: unknown): unknown {
  if (typeof value !== "string") return value ?? undefined
  return JSON.parse(value)
}

function reviveExpandedLinks(value: unknown): ObjectRowLinks | undefined {
  if (!isPlainObject(value)) return undefined
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

// Revive one hydrated neighbour from `compileExpansionChildJson`: timestamp
// strings back to `Date`, null/empty link properties dropped (matching the
// fallback), and nested links recursed.
function reviveExpandedRow(value: unknown): ExpandedObjectRow {
  const row = isPlainObject(value) ? value : {}
  const expanded: ExpandedObjectRow = {
    projectId: String(row.projectId),
    objectTypeId: String(row.objectTypeId),
    primaryId: String(row.primaryId),
    properties: isPlainObject(row.properties) ? row.properties : {},
    createdAt: new Date(row.createdAt as string),
    updatedAt: new Date(row.updatedAt as string),
    version: Number(row.version),
    lastCommitId: String(row.lastCommitId),
  }
  if (isPlainObject(row.linkProperties) && Object.keys(row.linkProperties).length > 0) {
    expanded.linkProperties = row.linkProperties
  }
  const links = reviveExpandedLinks(row.links)
  if (links) expanded.links = links
  return expanded
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface DatabaseRow {
  project_id: string
  object_type_id: string
  primary_id: string
  properties: string
  created_at: string
  updated_at: string
  version: number
  last_commit_id: string
}

export interface ObjectQueryDatabaseRow extends DatabaseRow {
  _cursor_properties?: string
  /** `json_object(linkId, value, ...)` serialized text from an `expand` pushdown; absent otherwise. */
  _expand?: string | null
}

export interface LinkDatabaseRow {
  project_id: string
  source_type_id: string
  source_id: string
  link_id: string
  target_type_id: string
  target_id: string
  properties: string | null
  created_at: string
  updated_at: string
  last_commit_id: string
}
