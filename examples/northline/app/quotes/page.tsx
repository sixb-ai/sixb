import type { ListWorkflowInterventionsResponse } from "@sixb/client"
import {
  listWorkflowInterventionsOptions,
  listWorkflowInterventionsQueryKey,
  submitWorkflowInterventionMutation,
  useActionRunMutation,
  useObjectsQuery,
} from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Button, Input } from "@sixb/ui/components"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, ArrowUpDown, Check, ChevronRight, LoaderCircle, Search, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Quote } from "../../ontology/quote"
import { ServiceCase } from "../../ontology/service-case"
import { formatDate, formatMoney, formatRelativeTime, QueryState } from "../_components/ui"
import type { QueryRow } from "../_lib/query-types"

const allQuotes = objects(Quote)
  .query()
  .expand(Quote.l.customer)
  .expand(Quote.l.facility)
  .expand(Quote.l.serviceCase)
  .orderBy(Quote.p.validUntil, "asc")
  .limit(100)

const linkedServiceCases = objects(ServiceCase).query().expand(ServiceCase.l.equipment).limit(100)

const reviewQuery = {
  interventionId: "review-repair-quote",
  status: "pending" as const,
  limit: "100",
  order: "desc" as const,
}

const views = [
  ["all", "All"],
  ["internal_review", "Internal review"],
  ["sent", "Awaiting customer"],
  ["approved", "Approved"],
  ["declined", "Declined"],
  ["expiring", "Expiring soon"],
] as const

const sortOptions = [
  ["urgency", "Decision urgency"],
  ["expiration", "Expiration date"],
  ["amount", "Highest value"],
  ["number", "Quote number"],
] as const

type QuoteRow = QueryRow<typeof allQuotes>
type ServiceCaseRow = QueryRow<typeof linkedServiceCases>
type Intervention = ListWorkflowInterventionsResponse["interventions"][number]
type View = (typeof views)[number][0]
type Sort = (typeof sortOptions)[number][0]
type QuoteDecision = "approved" | "declined"

export default function QuotesPage() {
  const queryClient = useQueryClient()
  const [view, setView] = useState<View>("all")
  const [sort, setSort] = useState<Sort>("urgency")
  const [search, setSearch] = useState("")
  const [expandedQuoteId, setExpandedQuoteId] = useState<string>()
  const [submittingId, setSubmittingId] = useState<string>()
  const quotes = useObjectsQuery(allQuotes)
  const serviceCases = useObjectsQuery(linkedServiceCases)
  const reviews = useQuery(listWorkflowInterventionsOptions({ query: reviewQuery }))
  const submit = useMutation({
    ...submitWorkflowInterventionMutation(),
    onSuccess: async () => {
      setExpandedQuoteId(undefined)
      await queryClient.invalidateQueries({
        queryKey: listWorkflowInterventionsQueryKey({ query: reviewQuery }),
      })
    },
    onSettled: () => setSubmittingId(undefined),
  })

  const allRows = quotes.data?.objects ?? []
  const caseRows = serviceCases.data?.objects ?? []
  const pendingReviews = reviews.data?.interventions ?? []
  const blockedValue = allRows
    .filter((quote) => ["internal_review", "sent"].includes(quote.properties.status))
    .reduce((total, quote) => total + quote.properties.amount, 0)
  const visibleRows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allRows
      .filter((quote) => {
        if (!matchesView(quote, view)) return false
        if (!normalized) return true
        return [
          quote.properties.number,
          quote.properties.scope,
          quote.properties.reason,
          quote.links.customer?.properties.name,
          quote.links.facility?.properties.name,
          quote.links.serviceCase?.properties.number,
        ].some((value) => value?.toLowerCase().includes(normalized))
      })
      .sort((left, right) => compareQuotes(left, right, sort))
  }, [allRows, search, sort, view])
  const unmatchedReviews = pendingReviews.filter((intervention) => {
    const caseNumber = text(intervention.input.caseNumber)
    return !allRows.some((quote) => quote.links.serviceCase?.properties.number === caseNumber)
  })

  return (
    <div className="pb-8">
      <header className="mb-6 flex items-start justify-between gap-6 max-sm:flex-col">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Commercial authorization
          </p>
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
            Quotes
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Repair proposals and customer decisions connected to the service work they unblock.
          </p>
        </div>
        <div className="shrink-0 text-right max-sm:text-left">
          <strong className="block font-mono text-xl font-semibold">
            {formatBlockedValue(blockedValue)}
          </strong>
          <span className="text-xs text-muted-foreground">awaiting decision</span>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <label className="relative block">
          <span className="sr-only">Search quotes</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search quotes, customers, or service cases"
            className="h-12 rounded-lg border-border/90 bg-card pl-11 text-sm shadow-none focus-visible:ring-2"
          />
        </label>

        <label className="relative block">
          <span className="sr-only">Sort quotes</span>
          <ArrowUpDown
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            className="h-12 w-full appearance-none rounded-lg border border-border/90 bg-card pr-10 pl-11 text-sm font-medium text-foreground outline-none transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span
            className="pointer-events-none absolute top-1/2 right-4 size-2.5 -translate-y-2/3 rotate-45 border-r border-b border-muted-foreground"
            aria-hidden="true"
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="Quote views">
        {views.map(([value, label]) => {
          const count = allRows.filter((quote) => matchesView(quote, value)).length
          const active = view === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              className={
                active
                  ? "h-9 shrink-0 rounded-md border border-primary bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-sm"
                  : "h-9 shrink-0 rounded-md border border-border/90 bg-card px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground"
              }
              onClick={() => setView(value)}
            >
              {label} <span className="ml-1.5 font-mono text-[10px] opacity-75">{count}</span>
            </button>
          )
        })}
      </div>

      {unmatchedReviews.length > 0 ? (
        <section className="mt-3 overflow-hidden rounded-xl border border-[color:var(--warning)]/35 bg-card">
          <header className="border-b border-border/75 px-5 py-3">
            <h2 className="text-sm font-semibold">Northline review required</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Commercial scopes that have not created a quote record yet.
            </p>
          </header>
          <div className="divide-y divide-border/75">
            {unmatchedReviews.map((intervention) => (
              <UnmatchedReview
                key={intervention.id}
                intervention={intervention}
                pending={submit.isPending && submittingId === intervention.id}
                onApprove={(response) => {
                  setSubmittingId(intervention.id)
                  submit.mutate({
                    path: { interventionId: intervention.id },
                    body: { response },
                  })
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-3">
        <QueryState
          loading={quotes.isLoading || reviews.isLoading}
          error={quotes.isError || reviews.isError}
          empty={visibleRows.length === 0}
          emptyMessage="No quotes match this view."
        >
          <div className="grid gap-2.5">
            {visibleRows.map((quote) => {
              const relatedCase = caseRows.find(
                (serviceCase) => serviceCase.primaryId === quote.links.serviceCase?.primaryId
              )
              const review = pendingReviews.find(
                (intervention) =>
                  text(intervention.input.caseNumber) === quote.links.serviceCase?.properties.number
              )
              return (
                <QuoteWorklistRow
                  key={quote.primaryId}
                  quote={quote}
                  serviceCase={relatedCase}
                  review={review}
                  expanded={expandedQuoteId === quote.primaryId}
                  reviewPending={submit.isPending && submittingId === review?.id}
                  onToggle={() =>
                    setExpandedQuoteId((current) =>
                      current === quote.primaryId ? undefined : quote.primaryId
                    )
                  }
                  onApproveReview={(response) => {
                    if (!review) return
                    setSubmittingId(review.id)
                    submit.mutate({
                      path: { interventionId: review.id },
                      body: { response },
                    })
                  }}
                />
              )
            })}
          </div>
        </QueryState>
      </section>
    </div>
  )
}

function QuoteWorklistRow({
  quote,
  serviceCase,
  review,
  expanded,
  reviewPending,
  onToggle,
  onApproveReview,
}: {
  quote: QuoteRow
  serviceCase: ServiceCaseRow | undefined
  review: Intervention | undefined
  expanded: boolean
  reviewPending: boolean
  onToggle(): void
  onApproveReview(response: Record<string, unknown>): void
}) {
  const navigate = useNavigate()
  const decide = useActionRunMutation<{
    serviceCase: { objectTypeId: "ServiceCase"; primaryId: string }
    decision: QuoteDecision
  }>({
    actionId: "record-quote-decision",
    subject: { objectType: Quote, primaryId: quote.primaryId },
    invalidateOnCommit: true,
  })
  const linkedCase = quote.links.serviceCase
  const href = linkedCase
    ? `/service-cases/${encodeURIComponent(linkedCase.primaryId)}`
    : quote.links.customer
      ? `/customers/${encodeURIComponent(quote.links.customer.primaryId)}`
      : undefined
  const canRecordDecision =
    Boolean(linkedCase) && ["internal_review", "sent"].includes(quote.properties.status)
  const hasAction = Boolean(review) || canRecordDecision

  return (
    <article
      role={href ? "link" : undefined}
      tabIndex={href ? 0 : undefined}
      aria-label={href ? `Open related record for ${quote.properties.number}` : undefined}
      className={`group relative overflow-hidden rounded-xl border border-border/85 bg-card transition-[border-color,background-color,box-shadow] hover:border-primary/55 hover:bg-primary/[0.025] hover:shadow-[0_1px_2px_rgba(13,32,39,0.04)] focus-within:border-primary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        href ? "cursor-pointer" : ""
      }`}
      onClick={() => {
        if (href) navigate(href)
      }}
      onKeyDown={(event) => {
        if (href && event.currentTarget === event.target && event.key === "Enter") {
          navigate(href)
        }
      }}
    >
      <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-4 gap-y-4 px-3.5 py-3.5 xl:grid-cols-[82px_minmax(250px,1.35fr)_minmax(185px,0.78fr)_110px_minmax(150px,0.52fr)_auto_18px] xl:pr-5">
        <QuoteDocument number={quote.properties.number} />

        <div className="min-w-0 self-center">
          <div className="flex flex-wrap items-center gap-2.5">
            <strong className="font-mono text-xs font-semibold tracking-[-0.01em]">
              {quote.properties.number}
            </strong>
            <QuoteStatusIndicator status={quote.properties.status} />
          </div>
          <p className="mt-1.5 line-clamp-2 text-sm leading-5 font-semibold tracking-[-0.012em] text-foreground">
            {quote.properties.scope}
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            {quote.properties.reason}
          </p>
        </div>

        <div className="col-start-2 min-w-0 border-t border-border/65 pt-3 xl:col-start-auto xl:border-0 xl:pt-0">
          <p className="truncate text-xs font-medium text-primary">
            {linkedCase?.properties.number
              ? `${linkedCase.properties.number} · ${equipmentLabel(serviceCase, quote)}`
              : equipmentLabel(serviceCase, quote)}
          </p>
          <strong className="mt-2 block truncate text-xs font-semibold text-foreground">
            {quote.links.customer?.properties.name ?? "Customer"}
          </strong>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
            {quote.links.facility?.properties.name ?? "Facility"}
          </span>
        </div>

        <div className="col-start-2 xl:col-start-auto">
          <strong className="block font-mono text-sm font-semibold tracking-[-0.02em]">
            {formatMoney(quote.properties.amount)}
          </strong>
          <span className="mt-1 block text-[10px] text-muted-foreground">
            {quote.properties.currency}
          </span>
        </div>

        <div className="col-start-2 min-w-0 xl:col-start-auto">
          <strong className={`block text-xs font-medium ${stageTone(quote.properties.status)}`}>
            {stageLabel(quote.properties.status)}
          </strong>
          <span className="mt-1.5 block text-[11px] text-muted-foreground">
            {decisionDateLabel(quote)}
          </span>
          <span className={`mt-1.5 block text-[11px] font-medium ${outcomeTone(quote)}`}>
            {outcomeLabel(quote)}
          </span>
        </div>

        <div className="col-start-2 flex items-center xl:col-start-auto xl:justify-end">
          {hasAction ? (
            <Button
              size="sm"
              variant="outline"
              className="border-primary/65 text-primary hover:bg-primary hover:text-primary-foreground"
              onClick={(event) => {
                event.stopPropagation()
                onToggle()
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {review ? "Review & send" : "Record decision"}
            </Button>
          ) : null}
        </div>

        {href ? (
          <ChevronRight
            className="absolute right-4 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary xl:static"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        ) : (
          <ArrowRight
            className="absolute right-4 size-4 text-muted-foreground/55 xl:static"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
      </div>

      {expanded && hasAction ? (
        <div
          className="flex items-center justify-between gap-5 border-t border-border/75 bg-background/55 px-5 py-4 max-md:flex-col max-md:items-stretch"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {review ? (
            <ReviewDecision
              intervention={review}
              pending={reviewPending}
              onCancel={onToggle}
              onApprove={onApproveReview}
            />
          ) : linkedCase ? (
            <CustomerDecision
              quote={quote}
              pending={decide.isPending}
              onCancel={onToggle}
              onDecision={(decision) =>
                decide.mutate({
                  serviceCase: {
                    objectTypeId: "ServiceCase",
                    primaryId: linkedCase.primaryId,
                  },
                  decision,
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function QuoteDocument({ number: quoteNumber }: { number: string }) {
  return (
    <span className="grid h-[82px] w-[76px] place-items-center rounded-lg border border-primary/10 bg-secondary/75">
      <span className="relative h-[66px] w-[50px] overflow-hidden rounded-[3px] border border-border bg-card shadow-[0_2px_4px_rgba(13,32,39,0.08)]">
        <span className="absolute top-0 right-0 size-3 border-b border-l border-border bg-secondary" />
        <span className="absolute top-4 left-3 h-0.5 w-5 bg-primary" />
        <span className="absolute top-7 left-3 h-px w-7 bg-border" />
        <span className="absolute top-9 left-3 h-px w-6 bg-border" />
        <span className="absolute top-11 left-3 h-px w-7 bg-border" />
        <strong className="absolute bottom-2 left-2.5 font-mono text-[8px] font-semibold text-foreground">
          {quoteNumber}
        </strong>
      </span>
    </span>
  )
}

function QuoteStatusIndicator({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "text-[color:var(--success)] before:bg-[color:var(--success)]"
      : status === "sent"
        ? "text-[color:var(--info)] before:bg-[color:var(--info)]"
        : status === "internal_review"
          ? "text-[color:var(--warning)] before:bg-[color:var(--warning)]"
          : status === "declined" || status === "expired"
            ? "text-destructive before:bg-destructive"
            : "text-muted-foreground before:bg-muted-foreground/65"
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs font-medium before:size-1.5 before:rounded-full ${tone}`}
    >
      {quoteStatusLabel(status)}
    </span>
  )
}

function ReviewDecision({
  intervention,
  pending,
  onCancel,
  onApprove,
}: {
  intervention: Intervention
  pending: boolean
  onCancel(): void
  onApprove(response: Record<string, unknown>): void
}) {
  const scope = text(intervention.defaultResponse.scope ?? intervention.input.scope)
  const amount = numeric(intervention.defaultResponse.amount ?? intervention.input.amount)
  return (
    <>
      <div className="min-w-0">
        <strong className="text-xs font-semibold">Confirm Northline approval</strong>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Approve the repair scope and {formatMoney(amount)} quote before it is sent to the
          customer.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={pending || !scope || amount <= 0}
          onClick={() => onApprove({ scope, amount })}
        >
          {pending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          {pending ? "Sending…" : "Approve & send"}
        </Button>
      </div>
    </>
  )
}

function CustomerDecision({
  quote,
  pending,
  onCancel,
  onDecision,
}: {
  quote: QuoteRow
  pending: boolean
  onCancel(): void
  onDecision(decision: QuoteDecision): void
}) {
  return (
    <>
      <div className="min-w-0">
        <strong className="text-xs font-semibold">Record customer decision</strong>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Record whether the customer approved or declined the{" "}
          {formatMoney(quote.properties.amount)}
          repair proposal.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="border-destructive/35 text-destructive hover:bg-destructive hover:text-white"
          disabled={pending}
          onClick={() => onDecision("declined")}
        >
          <X className="size-4" /> Declined
        </Button>
        <Button size="sm" disabled={pending} onClick={() => onDecision("approved")}>
          {pending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          {pending ? "Saving…" : "Approved"}
        </Button>
      </div>
    </>
  )
}

function UnmatchedReview({
  intervention,
  pending,
  onApprove,
}: {
  intervention: Intervention
  pending: boolean
  onApprove(response: Record<string, unknown>): void
}) {
  const scope = text(intervention.defaultResponse.scope ?? intervention.input.scope)
  const amount = numeric(intervention.defaultResponse.amount ?? intervention.input.amount)
  return (
    <article className="flex items-center justify-between gap-5 px-5 py-4 max-sm:flex-col max-sm:items-stretch">
      <div className="min-w-0">
        <p className="font-mono text-xs font-semibold text-primary">
          {text(intervention.input.caseNumber) || "Service case"}
        </p>
        <p className="mt-1 truncate text-sm font-semibold">{scope || "Repair quote review"}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {text(intervention.input.reason)} · {formatMoney(amount)}
        </p>
      </div>
      <Button
        size="sm"
        disabled={pending || !scope || amount <= 0}
        onClick={() => onApprove({ scope, amount })}
      >
        {pending ? "Sending…" : "Approve & send"}
      </Button>
    </article>
  )
}

function matchesView(quote: QuoteRow, view: View): boolean {
  if (view === "all") return true
  if (view === "expiring") {
    return (
      ["internal_review", "sent"].includes(quote.properties.status) &&
      daysUntil(quote.properties.validUntil) <= 7
    )
  }
  return quote.properties.status === view
}

function compareQuotes(left: QuoteRow, right: QuoteRow, sort: Sort): number {
  if (sort === "number") {
    return right.properties.number.localeCompare(left.properties.number, undefined, {
      numeric: true,
    })
  }
  if (sort === "amount") return right.properties.amount - left.properties.amount
  if (sort === "expiration") {
    return dateValue(left.properties.validUntil) - dateValue(right.properties.validUntil)
  }
  return quotePriority(right) - quotePriority(left)
}

function quotePriority(quote: QuoteRow): number {
  const status = {
    internal_review: 60,
    sent: 50,
    draft: 40,
    expired: 30,
    declined: 10,
    approved: 0,
  }[quote.properties.status]
  return status + Math.max(0, 30 - daysUntil(quote.properties.validUntil))
}

function equipmentLabel(serviceCase: ServiceCaseRow | undefined, quote: QuoteRow): string {
  const linkedEquipment = serviceCase?.links.equipment?.properties.name
  if (linkedEquipment) return linkedEquipment
  const scope = quote.properties.scope.toLowerCase()
  if (scope.includes("controller")) return "Building Controller"
  const equipmentCode = quote.properties.scope.match(/\b(?:RTU|AHU)-\d+\b/i)?.[0]
  return equipmentCode?.toUpperCase() ?? "Service work"
}

function stageLabel(status: string): string {
  if (status === "internal_review") return "Northline approval"
  if (status === "sent") return "Awaiting customer"
  if (status === "approved" || status === "declined") return "Decision recorded"
  if (status === "expired") return "Quote expired"
  return "Draft preparation"
}

function stageTone(status: string): string {
  if (status === "approved") return "text-[color:var(--success)]"
  if (status === "sent") return "text-[color:var(--info)]"
  if (status === "internal_review") return "text-[color:var(--warning)]"
  if (status === "declined" || status === "expired") return "text-destructive"
  return "text-muted-foreground"
}

function decisionDateLabel(quote: QuoteRow): string {
  if (["approved", "declined"].includes(quote.properties.status)) {
    return quote.properties.decisionAt
      ? `${quoteStatusLabel(quote.properties.status)} ${formatDate(quote.properties.decisionAt)}`
      : quoteStatusLabel(quote.properties.status)
  }
  return `Valid until ${formatDate(quote.properties.validUntil)}`
}

function outcomeLabel(quote: QuoteRow): string {
  if (quote.properties.status === "internal_review") {
    return remainingLabel(quote.properties.validUntil)
  }
  if (quote.properties.status === "sent") {
    return quote.properties.sourceUpdatedAt
      ? `Sent ${formatRelativeTime(quote.properties.sourceUpdatedAt)}`
      : "Awaiting response"
  }
  if (quote.properties.status === "approved") return "Work returned to dispatch"
  if (quote.properties.status === "declined") return "Customer declined repair"
  if (quote.properties.status === "expired") return "No longer valid"
  return "Not yet sent"
}

function outcomeTone(quote: QuoteRow): string {
  if (quote.properties.status === "approved") return "text-[color:var(--success)]"
  if (quote.properties.status === "sent") return "text-[color:var(--info)]"
  if (quote.properties.status === "internal_review") return "text-[color:var(--warning)]"
  if (["declined", "expired"].includes(quote.properties.status)) return "text-destructive"
  return "text-muted-foreground"
}

function quoteStatusLabel(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

function remainingLabel(value: string | Date | undefined): string {
  const days = daysUntil(value)
  if (days < 0) return "Expired"
  if (days === 0) return "Expires today"
  if (days === 1) return "1 day remaining"
  return `${days} days remaining`
}

function daysUntil(value: string | Date | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(value)
  target.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000)
}

function dateValue(value: string | Date | undefined): number {
  return value ? new Date(value).getTime() : Number.POSITIVE_INFINITY
}

function formatBlockedValue(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : 0
}
