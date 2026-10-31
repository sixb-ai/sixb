import { listActionsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { humanize } from "../../../section-ui"

/**
 * An Action's name, read from its definition as the Actions page lists it, or its id as words
 * while the list loads or for an Action no longer defined.
 */
export function useActionName(actionId: string | undefined): string | null {
  const actions = useQuery({
    ...listActionsOptions(),
    enabled: actionId !== undefined,
    retry: false,
  }).data
  if (actionId === undefined) return null

  const action = actions?.find((candidate) => candidate.id === actionId)
  return humanize(action?.name || actionId)
}
