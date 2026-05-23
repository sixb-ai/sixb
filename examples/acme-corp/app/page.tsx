import type { ListWorkflowInterventionsResponse } from "@sixb/client"
import { listWorkflowInterventionsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"

type WorkflowIntervention = ListWorkflowInterventionsResponse["interventions"][number]

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

function reviewTitle(intervention: WorkflowIntervention): string {
  const invoice = asObjectRef(intervention.input.invoice)
  return invoice ? `Invoice ${invoice.primaryId}` : intervention.id
}

function PendingReviewCard({ intervention }: { intervention: WorkflowIntervention }) {
  return (
    <a className="review-card" href={`/review/${encodeURIComponent(intervention.id)}`}>
      <div className="review-card-main">
        <span className="status-pill">Pending</span>
        <h2>{reviewTitle(intervention)}</h2>
        <p>{String(intervention.input.message ?? "Open review details.")}</p>
      </div>
      <div className="review-card-meta">
        <span>{intervention.nodeKey}</span>
        <span>{formatDate(intervention.requestedAt)}</span>
      </div>
    </a>
  )
}

export default function ReviewQueuePage() {
  const reviewsQuery = useQuery(
    listWorkflowInterventionsOptions({
      query: {
        interventionId: "review-invoice-reminder",
        status: "pending",
        limit: "100",
        order: "desc",
      },
    })
  )
  const interventions = reviewsQuery.data?.interventions ?? []

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Acme Review Desk</p>
          <h1>Pending reminder reviews</h1>
        </div>
        <div className="count-badge">
          <span>{interventions.length}</span>
          <small>open</small>
        </div>
      </header>

      {reviewsQuery.isLoading ? (
        <section className="empty-state">
          <p>Loading review queue...</p>
        </section>
      ) : reviewsQuery.isError ? (
        <section className="empty-state error-state">
          <p>Review queue failed to load.</p>
        </section>
      ) : interventions.length === 0 ? (
        <section className="empty-state">
          <h2>No pending reviews</h2>
          <p>Workflow interventions that need a reviewer will appear here.</p>
        </section>
      ) : (
        <section className="review-list" aria-label="Pending workflow interventions">
          {interventions.map((intervention) => (
            <PendingReviewCard key={intervention.id} intervention={intervention} />
          ))}
        </section>
      )}
    </main>
  )
}
