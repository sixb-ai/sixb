import { compareStrings } from "../../json"
import type { QueryScalarKind } from "../../objects/query/ir"
import { linkTargetObjectTypeIds } from "../../objects/query/link-endpoints"
import {
  queryScalarKindForSchema,
  resolvePropertyQueryCapabilities,
  resolveQuerySchema,
} from "../../ontology/query-capabilities"
import type { OntologyDefinitionCatalog } from "../../ontology/registry"
import type { ObjectQueryIndexDefinition } from "../../ontology/types"
import type { SecurityDefinitionCatalog } from "../../security/registry"
import { viewConditionKeys } from "../../security/visibility-keys"
import type { Storage } from "../types"
import type { ObjectVisibilityKeys } from "./types"

export interface ObjectQueryPreparationPlan {
  readonly projectId: string
  readonly objectTypes: readonly {
    readonly objectTypeId: string
    readonly properties: readonly {
      readonly propertyId: string
      readonly scalarKind?: QueryScalarKind
      readonly filterable: boolean
      readonly sortable: boolean
      readonly text: boolean
    }[]
    readonly indexes: readonly ObjectQueryIndexDefinition[]
    /** The object types each link allows, subtypes included. Undefined for a wildcard link. */
    readonly links: readonly {
      readonly linkId: string
      readonly targetObjectTypeIds: readonly string[] | undefined
    }[]
    /**
     * The keys of every view condition a role puts on the type or a supertype, each once: a
     * member's reads of the type filter on them. Absent when preparation was not given the view
     * conditions, and a provider then leaves what it prepared for them as it is.
     */
    readonly visibility?: readonly ObjectVisibilityKeys[]
  }[]
}

export interface ObjectQueryPreparationResult {
  readonly status: "prepared" | "current"
  readonly objectTypes: number
  readonly indexes: number
  readonly warnings: readonly string[]
}

/** Optional maintenance capability, separate from object reads and writes. */
export interface QueryPreparationCapableStorage extends Storage {
  /** Coordinate concurrent callers and skip completed plans. Backfills may block writes. */
  prepareObjectQueries(plan: ObjectQueryPreparationPlan): Promise<ObjectQueryPreparationResult>
}

export function isQueryPreparationCapableStorage(
  storage: Storage
): storage is QueryPreparationCapableStorage {
  return "prepareObjectQueries" in storage && typeof storage.prepareObjectQueries === "function"
}

/** Prepare declared query access paths after schema migration. Providers own physical layout;
 * applications describe their ontology, not PostgreSQL expressions or generated columns.
 * This is maintenance: backfills may block writes and must not run in a request handler. */
export async function prepareObjectQueries(input: {
  projectId: string
  ontology: OntologyDefinitionCatalog
  /**
   * The roles' view conditions, whose keys member reads filter on. Without them, what was prepared
   * for them is left as it is.
   */
  security?: Pick<SecurityDefinitionCatalog, "listViewConditions">
  storage: Storage
}): Promise<ObjectQueryPreparationResult> {
  if (!isQueryPreparationCapableStorage(input.storage)) {
    throw new Error("[Sixb] This storage provider does not support object query preparation")
  }

  const values = input.ontology.getValueTypesById()
  const visibility = viewConditionKeysByType(input.security, input.ontology)
  const objectTypes = input.ontology.listObjectTypes().map((type) => ({
    objectTypeId: type.id,
    properties: type.properties
      .filter((property) => property.mode !== "telemetry" && !property.primary)
      .map((property) => {
        const capabilities = resolvePropertyQueryCapabilities(property, values)
        const schema = resolveQuerySchema(property.schema, values)
        return {
          propertyId: property.id,
          scalarKind: schema ? queryScalarKindForSchema(schema) : undefined,
          filterable: capabilities.operators.includes("eq"),
          sortable: capabilities.sortable,
          text: capabilities.text,
        }
      })
      .filter((property) => property.filterable || property.sortable || property.text),
    indexes: type.query?.indexes ?? [],
    links: type.links.map((link) => ({
      linkId: link.id,
      targetObjectTypeIds: linkTargetObjectTypeIds(link.targetObjectTypeId, input.ontology),
    })),
    ...(visibility ? { visibility: visibility.get(type.id) ?? [] } : {}),
  }))
  const result = await input.storage.prepareObjectQueries({
    projectId: input.projectId,
    objectTypes,
  })

  const unindexed = (input.security?.listViewConditions() ?? [])
    .filter((condition) => !viewConditionKeys(condition.predicate))
    .map(
      (condition) =>
        `Role '${condition.roleId}': can.view(${condition.objectTypeId}).where(...) negates currentUser() or needs it twice at once, so members' reads check every object.`
    )
  return unindexed.length > 0 ? { ...result, warnings: [...result.warnings, ...unindexed] } : result
}

/** Each concrete type's distinct condition keys, in a stable order. */
function viewConditionKeysByType(
  security: Pick<SecurityDefinitionCatalog, "listViewConditions"> | undefined,
  ontology: OntologyDefinitionCatalog
): ReadonlyMap<string, readonly ObjectVisibilityKeys[]> | undefined {
  if (!security) return undefined

  const keysByType = new Map<string, Map<string, ObjectVisibilityKeys>>()
  for (const condition of security.listViewConditions()) {
    const keys = viewConditionKeys(condition.predicate)
    if (!keys) continue

    for (const objectTypeId of [
      condition.objectTypeId,
      ...ontology.listSubTypes(condition.objectTypeId),
    ]) {
      const typeKeys = keysByType.get(objectTypeId) ?? new Map<string, ObjectVisibilityKeys>()
      typeKeys.set(JSON.stringify(keys), keys)
      keysByType.set(objectTypeId, typeKeys)
    }
  }

  return new Map(
    [...keysByType].map(([objectTypeId, keys]) => [
      objectTypeId,
      [...keys].sort(([left], [right]) => compareStrings(left, right)).map(([, value]) => value),
    ])
  )
}
