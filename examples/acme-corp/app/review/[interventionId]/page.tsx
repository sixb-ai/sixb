import { AgentPanel, agentContext, useAgentContext } from "@sixb/app/agents"
import type { GetWorkflowInterventionResponse } from "@sixb/client"
import {
  cancelWorkflowInterventionMutation,
  getWorkflowInterventionOptions,
  getWorkflowInterventionQueryKey,
  listWorkflowInterventionsQueryKey,
  submitWorkflowInterventionMutation,
} from "@sixb/client/hooks"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Textarea,
} from "@sixb/ui/components"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Invoice } from "../../../ontology/invoice"

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function asObjectRef(value: unknown): { objectTypeId: string; primaryId: string } | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const ref = value as { objectTypeId?: unknown; primaryId?: unknown }
  if (typeof ref.objectTypeId !== "string" || typeof ref.primaryId !== "string") {
    return null
  }

  return { objectTypeId: ref.objectTypeId, primaryId: ref.primaryId }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function invoiceLabel(intervention: GetWorkflowInterventionResponse): string {
  const invoice = asObjectRef(intervention.input.invoice)
  return invoice ? `${invoice.objectTypeId} ${invoice.primaryId}` : intervention.id
}

function Eyebrow({ children }: { children: string }) {
  return (
    <p className="text-xs font-bold tracking-[0.12em] text-accent-foreground uppercase">
      {children}
    </p>
  )
}

export default function ReviewDetailPage() {
  const { interventionId } = useParams<{ interventionId: string }>()
  const queryClient = useQueryClient()
  const path = { interventionId: interventionId ?? "" }
  const interventionQuery = useQuery({
    ...getWorkflowInterventionOptions({ path }),
    enabled: Boolean(interventionId),
  })
  const intervention = interventionQuery.data
  const invoiceRef = intervention ? asObjectRef(intervention.input.invoice) : null
  useAgentContext(
    invoiceRef?.objectTypeId === Invoice.id
      ? agentContext.object(Invoice, invoiceRef.primaryId)
      : null
  )
  const [approved, setApproved] = useState(true)
  const [message, setMessage] = useState("")
  const [reviewerNote, setReviewerNote] = useState("")
  const [resultMessage, setResultMessage] = useState("")

  useEffect(() => {
    if (!intervention) {
      return
    }

    setApproved(asBoolean(intervention.defaultResponse.approved, true))
    setMessage(
      asString(intervention.defaultResponse.message) || asString(intervention.input.message)
    )
    setReviewerNote(asString(intervention.defaultResponse.reviewerNote))
    setResultMessage("")
  }, [intervention])

  const invalidateReviewQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getWorkflowInterventionQueryKey({ path }),
      }),
      queryClient.invalidateQueries({
        queryKey: listWorkflowInterventionsQueryKey({
          query: {
            interventionId: "review-invoice-reminder",
            status: "pending",
            limit: "100",
            order: "desc",
          },
        }),
      }),
    ])
  }

  const submitReview = useMutation({
    ...submitWorkflowInterventionMutation(),
    async onSuccess(data) {
      await invalidateReviewQueries()
      setResultMessage(`Review submitted. Resume job ${data.jobId} was queued.`)
    },
  })
  const cancelReview = useMutation({
    ...cancelWorkflowInterventionMutation(),
    async onSuccess() {
      await invalidateReviewQueries()
      setResultMessage("Review cancelled and the waiting workflow run was cancelled.")
    },
  })

  if (!interventionId) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 pt-7 pb-11">
        <section className="rounded-lg border border-destructive/30 bg-destructive/10 px-5 py-12 text-center text-destructive">
          <p>Missing review id.</p>
        </section>
      </main>
    )
  }

  if (interventionQuery.isLoading) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 pt-7 pb-11">
        <section className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
          <p>Loading review...</p>
        </section>
      </main>
    )
  }

  if (!intervention) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 pt-7 pb-11">
        <section className="grid justify-items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-5 py-12 text-center text-destructive">
          <p>Review not found.</p>
          <Button asChild>
            <Link to="/">Back to queue</Link>
          </Button>
        </section>
      </main>
    )
  }

  const isPending = intervention.status === "pending"
  const canSubmit =
    isPending && message.trim().length > 0 && !submitReview.isPending && !cancelReview.isPending

  return (
    <div className="min-h-dvh xl:grid xl:grid-cols-[minmax(0,1fr)_26rem]">
      <main className="min-w-0 px-5 pt-7 pb-11">
        <div className="mx-auto w-full max-w-5xl">
          <header className="mb-5 flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
            <Link to="/" className="text-sm font-bold text-accent-foreground hover:underline">
              Back to queue
            </Link>
            <Badge
              variant={isPending ? "default" : "secondary"}
              className="capitalize max-md:self-start"
            >
              {intervention.status}
            </Badge>
          </header>

          <section className="grid grid-cols-[minmax(240px,340px)_minmax(0,1fr)] items-start gap-4 max-md:grid-cols-1">
            <Card className="shadow-sm">
              <CardHeader>
                <Eyebrow>Workflow Intervention</Eyebrow>
                <CardTitle className="text-2xl">{invoiceLabel(intervention)}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-3.5">
                  {[
                    ["Workflow", intervention.workflowId],
                    ["Requested", formatDate(intervention.requestedAt)],
                    ["Channel", asString(intervention.input.channel) || "standard"],
                    ["Batch", asString(intervention.input.deliveryBatchId) || "none"],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs font-bold tracking-wider text-muted-foreground uppercase">
                        {label}
                      </dt>
                      <dd className="mt-1 [overflow-wrap:anywhere]">{value}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            <Card className="shadow-sm">
              <CardHeader>
                <Eyebrow>Reviewer Response</Eyebrow>
                <CardTitle className="text-xl">Finalize reminder copy</CardTitle>
              </CardHeader>
              <CardContent>
                <fieldset
                  className="mb-4 grid grid-cols-2 gap-2 max-md:grid-cols-1"
                  disabled={!isPending}
                >
                  <legend className="mb-1.5 text-sm font-bold text-muted-foreground">
                    Decision
                  </legend>
                  <Button
                    type="button"
                    variant={approved ? "secondary" : "outline"}
                    className={approved ? "border border-primary text-accent-foreground" : ""}
                    onClick={() => setApproved(true)}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    variant={approved ? "outline" : "secondary"}
                    className={approved ? "" : "border border-primary text-accent-foreground"}
                    onClick={() => setApproved(false)}
                  >
                    Request changes
                  </Button>
                </fieldset>

                <label className="mt-3.5 grid gap-2">
                  <span className="text-sm font-bold text-muted-foreground">Reminder message</span>
                  <Textarea
                    className="resize-y"
                    value={message}
                    onChange={(event) => setMessage(event.currentTarget.value)}
                    rows={7}
                    disabled={!isPending}
                  />
                </label>

                <label className="mt-3.5 grid gap-2">
                  <span className="text-sm font-bold text-muted-foreground">Reviewer note</span>
                  <Textarea
                    className="resize-y"
                    value={reviewerNote}
                    onChange={(event) => setReviewerNote(event.currentTarget.value)}
                    rows={4}
                    disabled={!isPending}
                  />
                </label>

                {resultMessage && (
                  <p className="mt-3.5 rounded-md bg-accent px-3 py-2.5 text-sm text-accent-foreground">
                    {resultMessage}
                  </p>
                )}
                {submitReview.isError && (
                  <p className="mt-3.5 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                    Review submission failed.
                  </p>
                )}
                {cancelReview.isError && (
                  <p className="mt-3.5 rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                    Review cancellation failed.
                  </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2.5">
                  <Button
                    type="button"
                    className="min-w-36"
                    disabled={!canSubmit}
                    onClick={() => {
                      submitReview.mutate({
                        path,
                        body: {
                          response: {
                            approved,
                            message: message.trim(),
                            ...(reviewerNote.trim() ? { reviewerNote: reviewerNote.trim() } : {}),
                          },
                        },
                      })
                    }}
                  >
                    Submit review
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-w-36 text-destructive hover:text-destructive"
                    disabled={!isPending || submitReview.isPending || cancelReview.isPending}
                    onClick={() => {
                      cancelReview.mutate({
                        path,
                        body: {},
                      })
                    }}
                  >
                    Cancel workflow
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </main>

      <aside className="h-[42rem] min-h-0 border-t border-border bg-background xl:sticky xl:top-0 xl:h-dvh xl:border-t-0 xl:border-l">
        <AgentPanel agentId="invoice-assistant" className="h-full" />
      </aside>
    </div>
  )
}
