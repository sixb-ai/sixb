import type { QueryScalarKind } from "../../objects/query/ir"
import {
  queryScalarKindForSchema,
  resolvePropertyQueryCapabilities,
  resolveQuerySchema,
} from "../../ontology/query-capabilities"
import type { OntologyDefinitionCatalog } from "../../ontology/registry"
import type { ObjectQueryIndexDefinition } from "../../ontology/types"
import type { Storage } from "../types"

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
  storage: Storage
}): Promise<ObjectQueryPreparationResult> {
  if (!isQueryPreparationCapableStorage(input.storage)) {
    throw new Error("[Sixb] This storage provider does not support object query preparation")
  }

  const values = input.ontology.getValueTypesById()
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
  }))
  return input.storage.prepareObjectQueries({ projectId: input.projectId, objectTypes })
}
