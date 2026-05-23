import type { GetWorkflowInterventionResponse } from "@sixb/client"
import {
  cancelWorkflowInterventionMutation,
  getWorkflowInterventionOptions,
  getWorkflowInterventionQueryKey,
  listWorkflowInterventionsQueryKey,
  submitWorkflowInterventionMutation,
} from "@sixb/client/hooks"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"

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

export default function ReviewDetailPage() {
  const { interventionId } = useParams<{ interventionId: string }>()
  const queryClient = useQueryClient()
  const path = { interventionId: interventionId ?? "" }
  const interventionQuery = useQuery({
    ...getWorkflowInterventionOptions({ path }),
    enabled: Boolean(interventionId),
  })
  const intervention = interventionQuery.data
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
      <main className="app-shell">
        <section className="empty-state error-state">
          <p>Missing review id.</p>
        </section>
      </main>
    )
  }

  if (interventionQuery.isLoading) {
    return (
      <main className="app-shell">
        <section className="empty-state">
          <p>Loading review...</p>
        </section>
      </main>
    )
  }

  if (!intervention) {
    return (
      <main className="app-shell">
        <section className="empty-state error-state">
          <p>Review not found.</p>
          <a href="/">Back to queue</a>
        </section>
      </main>
    )
  }

  const isPending = intervention.status === "pending"
  const canSubmit =
    isPending && message.trim().length > 0 && !submitReview.isPending && !cancelReview.isPending

  return (
    <main className="app-shell">
      <header className="detail-topbar">
        <a href="/" className="back-link">
          Back to queue
        </a>
        <span className={`status-pill ${isPending ? "" : "is-muted"}`}>{intervention.status}</span>
      </header>

      <section className="detail-grid">
        <aside className="context-panel">
          <p className="eyebrow">Workflow Intervention</p>
          <h1>{invoiceLabel(intervention)}</h1>
          <dl>
            <div>
              <dt>Workflow</dt>
              <dd>{intervention.workflowId}</dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>{formatDate(intervention.requestedAt)}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{asString(intervention.input.channel) || "standard"}</dd>
            </div>
            <div>
              <dt>Batch</dt>
              <dd>{asString(intervention.input.deliveryBatchId) || "none"}</dd>
            </div>
          </dl>
        </aside>

        <section className="review-panel">
          <div className="panel-heading">
            <p className="eyebrow">Reviewer Response</p>
            <h2>Finalize reminder copy</h2>
          </div>

          <fieldset className="decision-control" disabled={!isPending}>
            <legend>Decision</legend>
            <button
              type="button"
              className={approved ? "is-selected" : ""}
              onClick={() => setApproved(true)}
            >
              Approve
            </button>
            <button
              type="button"
              className={!approved ? "is-selected" : ""}
              onClick={() => setApproved(false)}
            >
              Request changes
            </button>
          </fieldset>

          <label className="field">
            <span>Reminder message</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
              rows={7}
              disabled={!isPending}
            />
          </label>

          <label className="field">
            <span>Reviewer note</span>
            <textarea
              value={reviewerNote}
              onChange={(event) => setReviewerNote(event.currentTarget.value)}
              rows={4}
              disabled={!isPending}
            />
          </label>

          {resultMessage && <p className="result-message">{resultMessage}</p>}
          {submitReview.isError && <p className="error-text">Review submission failed.</p>}
          {cancelReview.isError && <p className="error-text">Review cancellation failed.</p>}

          <div className="actions-row">
            <button
              type="button"
              className="primary-action"
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
                    submittedBy: {
                      principalType: "user",
                      principalId: "acme-reviewer",
                    },
                  },
                })
              }}
            >
              Submit review
            </button>
            <button
              type="button"
              className="secondary-action"
              disabled={!isPending || submitReview.isPending || cancelReview.isPending}
              onClick={() => {
                cancelReview.mutate({
                  path,
                  body: {
                    cancelledBy: {
                      principalType: "user",
                      principalId: "acme-reviewer",
                    },
                  },
                })
              }}
            >
              Cancel workflow
            </button>
          </div>
        </section>
      </section>
    </main>
  )
}
