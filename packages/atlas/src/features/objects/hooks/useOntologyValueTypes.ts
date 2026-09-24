import type { ListObjectTypesResponse } from "@sixb/client"
import { listObjectTypesOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { collectValueTypeSchemas, ontologySchemas } from "../../../lib/valueSchema"

const noObjectTypes: ListObjectTypesResponse = []
const noExtraSchemas: readonly unknown[] = []

/**
 * The project's object types and the value type schemas their declarations
 * carry. Shares the workspace's `listObjectTypes` query, so it is normally
 * served from cache.
 *
 * `extraSchemas` adds schemas declared outside the ontology (workflow inputs,
 * action params) as further sources of value types; keep it referentially
 * stable.
 */
export function useOntologyValueTypes(extraSchemas: readonly unknown[] = noExtraSchemas) {
  const query = useQuery(listObjectTypesOptions())
  const objectTypes = query.data ?? noObjectTypes
  const valueTypes = useMemo(
    () => collectValueTypeSchemas([...ontologySchemas(objectTypes), ...extraSchemas]),
    [objectTypes, extraSchemas]
  )
  return { objectTypes, valueTypes, isLoading: query.isLoading }
}
