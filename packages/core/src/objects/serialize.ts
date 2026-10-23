import type { Redactions } from "../security/types"
import type {
  ExpandedLinkValue,
  ExpandedObjectRow,
  ObjectRowLinks,
  ObjectRowUsers,
} from "../storage/objects/types"

/**
 * Objects as the objects API answers them, in JSON: dates as ISO text. One owner for what the API
 * sends and what the Agent's layout check serves a page, so a page reads the same rows in both.
 */
export interface SerializedObject {
  readonly score?: number
  readonly primaryId: string
  readonly objectTypeId: string
  readonly properties: Record<string, unknown>
  readonly redactions?: Redactions
  readonly createdAt: string
  readonly updatedAt: string
}

type SerializedLinkValue = SerializedExpandedObject | SerializedExpandedObject[] | null

export interface SerializedExpandedObject extends SerializedObject {
  links?: Record<string, SerializedLinkValue>
  linkProperties?: Record<string, unknown>
  users?: ObjectRowUsers
}

export function serializeObject(row: {
  readonly score?: number
  readonly primaryId: string
  readonly objectTypeId: string
  readonly properties: Record<string, unknown>
  readonly redactions?: Redactions
  readonly createdAt: Date
  readonly updatedAt: Date
}): SerializedObject {
  return {
    ...(row.score === undefined ? {} : { score: row.score }),
    primaryId: row.primaryId,
    objectTypeId: row.objectTypeId,
    properties: row.properties,
    ...(row.redactions === undefined ? {} : { redactions: row.redactions }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Serialize a query row together with any `links` attached by an `expand` node.
 * Recurses through nested expansions; `linkProperties` carries edge metadata on
 * an expanded child. Only the query route hydrates links, so the plain list and
 * identity routes keep using `serializeObject`.
 */
export function serializeExpandedObject(row: ExpandedObjectRow): SerializedExpandedObject {
  const serialized: SerializedExpandedObject = serializeObject(row)
  if (row.links) serialized.links = serializeLinks(row.links)
  if (row.linkProperties !== undefined) serialized.linkProperties = row.linkProperties
  // Profiles are plain JSON: no dates to convert.
  if (row.users) serialized.users = row.users
  return serialized
}

function serializeLinks(links: ObjectRowLinks): Record<string, SerializedLinkValue> {
  const result: Record<string, SerializedLinkValue> = {}
  for (const [linkId, value] of Object.entries(links)) {
    result[linkId] = serializeLinkValue(value)
  }
  return result
}

function serializeLinkValue(value: ExpandedLinkValue): SerializedLinkValue {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(serializeExpandedObject)
  // Array.isArray does not narrow a readonly[] away, so assert the scalar case.
  return serializeExpandedObject(value as ExpandedObjectRow)
}
