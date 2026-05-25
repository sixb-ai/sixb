import {
  getWorkflowQueryKey,
  getWorkflowRunQueryKey,
  listWorkflowRunsInfiniteQueryKey,
  listWorkflowRunsQueryKey,
  listWorkflowsQueryKey,
  requestWorkflowRunMutation,
} from "@pario/client/hooks"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@pario/ui/components"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, Loader2, Play } from "lucide-react"
import { type SubmitEvent, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { WorkflowDetail } from "../utils/workflows"
import {
  buildWorkflowInput,
  createInitialWorkflowInputFormValues,
  type WorkflowInputFormErrors,
  type WorkflowInputFormValues,
  WorkflowRunInputFields,
  workflowInputPathKey,
} from "./WorkflowRunInputForm"

export function RequestWorkflowRunDialog({ workflow }: { workflow: WorkflowDetail }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<WorkflowInputFormValues>({})
  const [fieldErrors, setFieldErrors] = useState<WorkflowInputFormErrors>({})

  const requestRun = useMutation({
    ...requestWorkflowRunMutation(),
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: listWorkflowsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listWorkflowRunsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listWorkflowRunsInfiniteQueryKey() }),
        queryClient.invalidateQueries({
          queryKey: getWorkflowQueryKey({ path: { workflowId: workflow.id } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getWorkflowRunQueryKey({ path: { runId: response.runId } }),
        }),
      ])
      setOpen(false)
      navigate(`/runs/${response.runId}`)
    },
  })

  const inputFields = workflow.input ?? {}
  const inputFieldCount = Object.keys(inputFields).length
  const apiErrorMessage = errorToMessage(requestRun.error)

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    setValues(nextOpen ? createInitialWorkflowInputFormValues(inputFields) : {})
    setFieldErrors({})
    requestRun.reset()
  }

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
    requestRun.reset()

    const result = buildWorkflowInput(inputFields, values)
    setFieldErrors(result.errors)
    if (Object.keys(result.errors).length > 0) return

    requestRun.mutate({
      path: { workflowId: workflow.id },
      body: { input: result.input },
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" className="shrink-0">
          <Play className="h-4 w-4" />
          Run workflow
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(46rem,calc(100vh-2rem))] overflow-visible sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run workflow</DialogTitle>
          <DialogDescription>
            Request a manual run for <span className="font-mono">{workflow.id}</span>.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <section className="max-h-[min(32rem,calc(100vh-16rem))] space-y-3 overflow-y-auto pr-1">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Run input
              </p>
              <span className="text-xs tabular-nums text-muted-foreground">
                {inputFieldCount} {inputFieldCount === 1 ? "field" : "fields"}
              </span>
            </div>

            <WorkflowRunInputFields
              fields={inputFields}
              values={values}
              errors={fieldErrors}
              onChange={setFieldValue}
            />
          </section>

          {apiErrorMessage ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Run request failed</AlertTitle>
              <AlertDescription>{apiErrorMessage}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={requestRun.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={requestRun.isPending}>
              {requestRun.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {requestRun.isPending ? "Requesting..." : "Run workflow"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function errorToMessage(error: unknown): string | null {
  if (!error) return null
  if (isRecord(error) && typeof error.error === "string") return error.error
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Could not request workflow run."
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
