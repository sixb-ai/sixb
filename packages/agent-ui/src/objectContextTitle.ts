import { type GetObjectResponse, type GetObjectTypeResponse, getObject } from "@sixb/client"
import { getObjectTypeOptions } from "@sixb/client/hooks"
import type { AgentContextInput } from "@sixb/core/agents/context"
import type { ObjectRef } from "@sixb/core/ontology"
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAgentMessages } from "./i18n"
import { agentContextLabel } from "./utils/contextDisplay"

/**
 * The label a context chip shows: the app's explicit label, else the object's title (its type's
 * `search.title`, read with the viewer's permissions), else a label derived from its id. The id
 * label also covers loading and failures, so a chip never renders empty.
 */
export function useAgentContextLabel(context: AgentContextInput): string {
  const unnamed = useAgentMessages().context.unnamed
  const queryClient = useQueryClient()
  const ref = context.kind === "object" && context.label === undefined ? context.ref : null
  const title = useQuery({
    ...objectContextTitleQuery(queryClient, ref ?? { objectTypeId: "", primaryId: "" }),
    enabled: ref !== null,
  })
  return (ref !== null ? title.data : undefined) ?? agentContextLabel(context, unnamed)
}

/** Type metadata is cached once per type; the title once per object. Failures resolve nothing. */
export function objectContextTitleQuery(queryClient: QueryClient, ref: ObjectRef) {
  return queryOptions({
    queryKey: ["sixb-agent-ui", "object-context-title", ref.objectTypeId, ref.primaryId] as const,
    queryFn: async ({ signal }) => {
      const objectType = await queryClient.fetchQuery({
        ...getObjectTypeOptions({ path: { objectTypeId: ref.objectTypeId } }),
        staleTime: Number.POSITIVE_INFINITY,
      })
      if (!objectType.search?.title) return null
      const { data } = await getObject({
        path: { objectTypeId: ref.objectTypeId, objectId: ref.primaryId },
        signal,
        throwOnError: true,
      })
      return objectContextTitle(objectType, data)
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** The value of the type's title property, when the viewer can read a non-empty one. */
export function objectContextTitle(
  objectType: Pick<GetObjectTypeResponse, "search">,
  object: Pick<GetObjectResponse, "properties">
): string | null {
  const property = objectType.search?.title
  if (!property) return null
  const value = object.properties[property]
  const title = typeof value === "string" || typeof value === "number" ? String(value).trim() : ""
  return title || null
}
