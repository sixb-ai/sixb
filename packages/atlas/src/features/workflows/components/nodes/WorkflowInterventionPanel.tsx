import {
  getWorkflowOptions,
  getWorkflowQueryKey,
  getWorkflowRunQueryKey,
  listWorkflowInterventionsOptions,
  listWorkflowInterventionsQueryKey,
  listWorkflowRunsInfiniteQueryKey,
  listWorkflowRunsQueryKey,
  listWorkflowsQueryKey,
  submitWorkflowInterventionMutation,
} from "@sixb/client/hooks"
import { Alert, AlertDescription, AlertTitle, Button, CardTitle } from "@sixb/ui/components"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, Loader2, Send, UserCheck } from "lucide-react"
import { type SubmitEvent, useEffect, useState } from "react"
import { formatDate, type WorkflowRunNode } from "../../utils/workflows"
import {
  buildWorkflowInput,
  createInitialWorkflowInputFormValues,
  type WorkflowInputFormErrors,
  type WorkflowInputFormValues,
  WorkflowRunInputFields,
  workflowInputPathKey,
} from "../WorkflowRunInputForm"

const emptyFields: Readonly<Record<string, unknown>> = {}

export function WorkflowInterventionPanel({ node }: { node: WorkflowRunNode }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<WorkflowInputFormValues>({})
  const [fieldErrors, setFieldErrors] = useState<WorkflowInputFormErrors>({})
  const [resultMessage, setResultMessage] = useState("")
  const [initializedInterventionId, setInitializedInterventionId] = useState<string | null>(null)

  const interventionQueryOptions = {
    query: {
      nodeRunId: node.id,
      status: "pending" as const,
      limit: "1",
      order: "desc" as const,
    },
  }
  const interventionsQuery = useQuery({
    ...listWorkflowInterventionsOptions(interventionQueryOptions),
  })
  const workflowQuery = useQuery(getWorkflowOptions({ path: { workflowId: node.workflowId } }))
  const intervention = interventionsQuery.data?.interventions[0]
  const workflowNode = workflowQuery.data?.nodes.find(
    (candidate) =>
      candidate.type === "intervention" &&
      candidate.id === node.nodeId &&
      candidate.key === node.nodeKey &&
      candidate.id === intervention?.nodeId
  )
  const responseFields = workflowNode?.type === "intervention" ? workflowNode.response : emptyFields
  const responseFieldCount = Object.keys(responseFields).length
  const schemaReady = Boolean(workflowNode)
  const apiErrorMessage = errorToMessage(interventionsQuery.error ?? workflowQuery.error)

  const submitResponse = useMutation({
    ...submitWorkflowInterventionMutation(),
    async onSuccess(data) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: listWorkflowInterventionsQueryKey(interventionQueryOptions),
        }),
        queryClient.invalidateQueries({ queryKey: listWorkflowInterventionsQueryKey() }),
        queryClient.invalidateQueries({
          queryKey: getWorkflowRunQueryKey({ path: { runId: node.workflowRunId } }),
        }),
        queryClient.invalidateQueries({ queryKey: listWorkflowRunsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listWorkflowRunsInfiniteQueryKey() }),
        queryClient.invalidateQueries({
          queryKey: getWorkflowQueryKey({ path: { workflowId: node.workflowId } }),
        }),
        queryClient.invalidateQueries({ queryKey: listWorkflowsQueryKey() }),
      ])
      setResultMessage(`Response submitted. Resume job ${data.jobId} was queued.`)
    },
  })

  useEffect(() => {
    if (!intervention || !schemaReady || initializedInterventionId === intervention.id) return

    setValues(createInitialWorkflowInputFormValues(responseFields, intervention.defaultResponse))
    setFieldErrors({})
    setResultMessage("")
    submitResponse.reset()
    setInitializedInterventionId(intervention.id)
  }, [initializedInterventionId, intervention, responseFields, schemaReady, submitResponse.reset])

  function setFieldValue(path: readonly string[], value: string) {
    const key = workflowInputPathKey(path)
    setValues((current) => ({ ...current, [key]: value }))
    setFieldErrors((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!intervention || !schemaReady) return

    submitResponse.reset()
    setResultMessage("")

    const result = buildWorkflowInput(responseFields, values)
    setFieldErrors(result.errors)
    if (Object.keys(result.errors).length > 0) return

    submitResponse.mutate({
      path: { interventionId: intervention.id },
      body: {
        response: result.input,
        submittedBy: {
          principalType: "user",
          principalId: "atlas-ui",
        },
      },
    })
  }

  const loading = interventionsQuery.isLoading || (Boolean(intervention) && workflowQuery.isLoading)
  const canSubmit =
    intervention?.status === "pending" &&
    schemaReady &&
    !submitResponse.isPending &&
    !interventionsQuery.isError

  return (
    <div className="border-t border-border/60 bg-card p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
              <UserCheck className="h-4 w-4" />
            </span>
            <CardTitle className="truncate text-sm font-medium">Human intervention</CardTitle>
          </div>
          {intervention ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Requested {formatDate(intervention.requestedAt)}
            </p>
          ) : null}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {responseFieldCount} response field{responseFieldCount === 1 ? "" : "s"}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading pending intervention...</p>
      ) : apiErrorMessage ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Intervention unavailable</AlertTitle>
          <AlertDescription>{apiErrorMessage}</AlertDescription>
        </Alert>
      ) : !intervention ? (
        <Alert>
          <UserCheck className="h-4 w-4" />
          <AlertTitle>No pending intervention</AlertTitle>
          <AlertDescription>
            This node is waiting, but Atlas could not find a pending intervention record.
          </AlertDescription>
        </Alert>
      ) : !schemaReady ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Response schema unavailable</AlertTitle>
          <AlertDescription>
            The pending intervention does not match the registered workflow definition.
          </AlertDescription>
        </Alert>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <WorkflowRunInputFields
            fields={responseFields}
            values={values}
            errors={fieldErrors}
            emptyLabel="This intervention does not require a structured response."
            onChange={setFieldValue}
          />

          {resultMessage ? (
            <Alert>
              <UserCheck className="h-4 w-4" />
              <AlertTitle>Response accepted</AlertTitle>
              <AlertDescription>{resultMessage}</AlertDescription>
            </Alert>
          ) : null}

          {submitResponse.isError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Submission failed</AlertTitle>
              <AlertDescription>
                {errorToMessage(submitResponse.error) ?? "Could not submit the response."}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex justify-end">
            <Button type="submit" disabled={!canSubmit}>
              {submitResponse.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {submitResponse.isPending ? "Submitting..." : "Submit response"}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function errorToMessage(error: unknown): string | null {
  if (!error) return null
  if (isRecord(error) && typeof error.error === "string") return error.error
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Could not load the intervention."
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
