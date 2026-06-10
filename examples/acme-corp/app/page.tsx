import type { ListWorkflowInterventionsResponse } from "@sixb/client"
import { listWorkflowInterventionsOptions } from "@sixb/client/hooks"
import { Badge } from "@sixb/ui/components"
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
  // A plain anchor on purpose: the generated app entry intercepts same-origin
  // anchor clicks and routes them client-side, so this navigates like <Link>.
  return (
    <a
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-lg border bg-card p-4 no-underline shadow-sm transition hover:-translate-y-px hover:border-primary"
      href={`/review/${encodeURIComponent(intervention.id)}`}
    >
      <div>
        <Badge className="bg-accent text-accent-foreground">Pending</Badge>
        <h2 className="mt-2.5 text-lg font-semibold text-foreground">
          {reviewTitle(intervention)}
        </h2>
        <p className="mt-2 max-w-3xl leading-snug text-muted-foreground">
          {String(intervention.input.message ?? "Open review details.")}
        </p>
      </div>
      <div className="grid min-w-44 content-center gap-1.5 text-right text-sm text-muted-foreground max-md:min-w-0 max-md:text-left">
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
    <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 pt-7 pb-11">
      <header className="mb-5 flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
        <div>
          <p className="text-xs font-bold tracking-[0.12em] text-accent-foreground uppercase">
            Acme Review Desk
          </p>
          <h1 className="mt-1 text-4xl leading-tight font-semibold max-md:text-2xl">
            Pending reminder reviews
          </h1>
        </div>
        <div className="flex min-h-14 min-w-19 flex-col items-center justify-center rounded-full border bg-accent font-bold text-accent-foreground max-md:self-start">
          <span className="text-xl">{interventions.length}</span>
          <small className="text-xs text-muted-foreground">open</small>
        </div>
      </header>

      {reviewsQuery.isLoading ? (
        <section className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
          <p>Loading review queue...</p>
        </section>
      ) : reviewsQuery.isError ? (
        <section className="rounded-lg border border-destructive/30 bg-destructive/10 px-5 py-12 text-center text-destructive shadow-sm">
          <p>Review queue failed to load.</p>
        </section>
      ) : interventions.length === 0 ? (
        <section className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
          <h2 className="text-lg font-semibold">No pending reviews</h2>
          <p className="mt-2 text-muted-foreground">
            Workflow interventions that need a reviewer will appear here.
          </p>
        </section>
      ) : (
        <section className="grid gap-3" aria-label="Pending workflow interventions">
          {interventions.map((intervention) => (
            <PendingReviewCard key={intervention.id} intervention={intervention} />
          ))}
        </section>
      )}
    </main>
  )
}
