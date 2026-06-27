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
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 rounded-lg border border-border/80 bg-card px-4 py-4 no-underline shadow-sm transition hover:-translate-y-px hover:border-primary/50 hover:bg-accent/20 max-md:grid-cols-1"
      href={`/review/${encodeURIComponent(intervention.id)}`}
    >
      <div>
        <Badge className="border border-primary/10 bg-accent text-accent-foreground">Pending</Badge>
        <h2 className="mt-3 text-base font-semibold text-foreground">
          {reviewTitle(intervention)}
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {String(intervention.input.message ?? "Open review details.")}
        </p>
      </div>
      <div className="grid min-w-44 content-center gap-1.5 text-right text-xs text-muted-foreground max-md:min-w-0 max-md:text-left">
        <span>{intervention.nodeKey}</span>
        <span>{formatDate(intervention.requestedAt)}</span>
      </div>
    </a>
  )
}

function HeaderLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      className="inline-flex h-10 items-center justify-center rounded-lg border border-border/80 bg-card px-4 text-sm font-semibold text-foreground no-underline shadow-sm transition hover:-translate-y-px hover:border-primary/50 hover:text-primary"
      href={href}
    >
      {children}
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
    <main className="mx-auto min-h-dvh w-full max-w-6xl px-5 pt-12 pb-12 max-md:pt-7">
      <header className="mb-7 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="max-w-3xl">
          <p className="text-xs font-bold tracking-[0.18em] text-primary uppercase">
            Acme Review Desk
          </p>
          <h1 className="mt-2 text-4xl leading-tight font-semibold tracking-normal text-foreground max-md:text-3xl">
            Pending reminder reviews
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
            Review customer payment reminders before workflow automation sends them.
          </p>
        </div>

        <div className="flex items-center gap-3 max-md:flex-wrap">
          <HeaderLink href="/projects">Projects →</HeaderLink>
          <HeaderLink href="/agents">Agents →</HeaderLink>
          <div className="grid h-16 min-w-20 place-items-center rounded-lg border border-primary/15 bg-accent px-4 text-center shadow-sm">
            <span className="text-2xl leading-none font-semibold text-accent-foreground">
              {interventions.length}
            </span>
            <small className="mt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              open
            </small>
          </div>
        </div>
      </header>

      {reviewsQuery.isLoading ? (
        <section className="rounded-lg border border-border/80 bg-card px-5 py-14 text-center shadow-sm">
          <p>Loading review queue...</p>
        </section>
      ) : reviewsQuery.isError ? (
        <section className="rounded-lg border border-destructive/30 bg-destructive/10 px-5 py-14 text-center text-destructive shadow-sm">
          <p>Review queue failed to load.</p>
        </section>
      ) : interventions.length === 0 ? (
        <section className="rounded-lg border border-border/80 bg-card px-6 py-16 text-center shadow-sm">
          <p className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full border border-primary/10 bg-accent text-sm font-semibold text-accent-foreground">
            0
          </p>
          <h2 className="text-lg font-semibold text-foreground">No pending reviews</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
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
