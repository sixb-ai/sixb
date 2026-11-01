import { objectCountOptions } from "@sixb/client/hooks"
import { type UseQueryResult, useQueries } from "@tanstack/react-query"
import { useCallback } from "react"

/** How many objects each type holds, by type id; a type whose count is not in yet is absent. */
export function useObjectTypeCounts(
  objectTypes: readonly { readonly id: string }[]
): ReadonlyMap<string, number> {
  // A stable `combine` keeps the map the same object until a count changes.
  const combine = useCallback(
    (results: UseQueryResult<number>[]) =>
      new Map(
        objectTypes.flatMap((type, index) => {
          const count = results[index]?.data
          return typeof count === "number" ? [[type.id, count] as const] : []
        })
      ),
    [objectTypes]
  )
  return useQueries({
    queries: objectTypes.map((type) => ({
      ...objectCountOptions({ query: { objectTypeId: type.id } }),
      retry: false,
    })),
    combine,
  })
}
