import type {
  ListWorkflowInterventionsResponse,
  SubmitWorkflowInterventionData,
} from "@sixb/client"
import {
  listWorkflowInterventionsOptions,
  listWorkflowInterventionsQueryKey,
  submitWorkflowInterventionMutation,
} from "@sixb/client/hooks"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

export type Intervention = ListWorkflowInterventionsResponse["interventions"][number]
export type InterventionResponse = SubmitWorkflowInterventionData["body"]["response"]

/**
 * A workflow intervention's pending reviews, and approving one. `submitting` and `failed` name
 * the review an approval was for, so each card shows only its own.
 */
export function useInterventionReviews(interventionId: string, onApproved?: () => void) {
  const queryClient = useQueryClient()
  const query = { interventionId, status: "pending" as const, limit: "100", order: "desc" as const }
  const reviews = useQuery(listWorkflowInterventionsOptions({ query }))
  const submit = useMutation({
    ...submitWorkflowInterventionMutation(),
    onSuccess: async () => {
      onApproved?.()
      await queryClient.invalidateQueries({
        queryKey: listWorkflowInterventionsQueryKey({ query }),
      })
    },
  })
  const approving = submit.variables?.path.interventionId
  return {
    reviews,
    pending: reviews.data?.interventions ?? [],
    approve(intervention: Intervention, response: InterventionResponse) {
      submit.mutate({ path: { interventionId: intervention.id }, body: { response } })
    },
    submitting: (intervention: Intervention | undefined) =>
      submit.isPending && approving === intervention?.id,
    failed: (intervention: Intervention | undefined) =>
      submit.isError && approving === intervention?.id,
  }
}

// An intervention's input and default response are untyped JSON; these read one value safely.

export function refValue(value: unknown): { objectTypeId: string; primaryId: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const ref = value as { objectTypeId?: unknown; primaryId?: unknown }
  return typeof ref.objectTypeId === "string" && typeof ref.primaryId === "string"
    ? { objectTypeId: ref.objectTypeId, primaryId: ref.primaryId }
    : undefined
}

export function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

export function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0
}
