import { getObjectLineageOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import type { ObjectLineage } from "./model"

/**
 * Where an object's values come from, read once for its whole page beside the object itself.
 * Lineage only adds to the page, so while it loads, or when the reader may not see it, the page
 * reads as it did without it. Object events refresh it with the object.
 */
export function useObjectLineage(
  objectTypeId: string | undefined,
  primaryId: string | undefined
): ObjectLineage | undefined {
  return useQuery({
    ...getObjectLineageOptions({
      path: { objectTypeId: objectTypeId ?? "", objectId: primaryId ?? "" },
    }),
    enabled: Boolean(objectTypeId && primaryId),
    retry: false,
  }).data
}
