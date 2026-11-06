import type {
  ListWorkflowInterventionsResponse,
  SubmitWorkflowInterventionData,
} from "@sixb/client"
import {
  listWorkflowInterventionsOptions,
  listWorkflowInterventionsQueryKey,
  submitWorkflowInterventionMutation,
  useActionRunMutation,
  useObjectsQuery,
} from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, FileText } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Quote } from "../../ontology/quote"
import { ServiceCase } from "../../ontology/service-case"
import { SearchField, SortSelect, ViewPills } from "../_components/list-controls"
import {
  daysUntil,
  Fact,
  formatDate,
  formatMoney,
  formatRelativeTime,
  humanize,
  PageHeader,
  QueryState,
  Row,
  Section,
  StatusBadge,
} from "../_components/ui"
import type { QueryRow } from "../_lib/query-types"
import { quotePath } from "../_lib/quotes"

const allQuotes = objects(Quote)
  .query()
  .expand(Quote.l.customer)
  .expand(Quote.l.facility)
  .expand(Quote.l.serviceCase)
  .orderBy(Quote.p.validUntil, "asc")
  .limit(100)

const linkedServiceCases = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .limit(100)

const reviewQuery = {
  interventionId: "review-repair-quote",
  status: "pending" as const,
  limit: "100",
  order: "desc" as const,
}

const views = [
  ["all", "All"],
  ["internal_review", "Internal review"],
  ["sent", "With customer"],
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

const decisionCardClass =
  "flex flex-col gap-4 rounded-[20px] bg-card p-6 shadow-[0_0_0_1.5px_var(--primary),0_10px_28px_color-mix(in_srgb,var(--primary)_12%,transparent)]"

type QuoteRow = QueryRow<typeof allQuotes>
type ServiceCaseRow = QueryRow<typeof linkedServiceCases>
type Intervention = ListWorkflowInterventionsResponse["interventions"][number]
type InterventionResponse = SubmitWorkflowInterventionData["body"]["response"]
type View = (typeof views)[number][0]
type Sort = (typeof sortOptions)[number][0]
type QuoteDecision = "approved" | "declined"

export default function QuotesPage() {
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const selectedId = searchParams.get("quote")
  const [view, setView] = useState<View>("all")
  const [sort, setSort] = useState<Sort>("urgency")
  const [search, setSearch] = useState("")
  const [submittingId, setSubmittingId] = useState<string>()
  const quotes = useObjectsQuery(allQuotes)
  const serviceCases = useObjectsQuery(linkedServiceCases)
  const reviews = useQuery(listWorkflowInterventionsOptions({ query: reviewQuery }))
  const submit = useMutation({
    ...submitWorkflowInterventionMutation(),
    onSuccess: async () => {
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
    .filter((quote) => isOpen(quote.properties.status))
    .reduce((total, quote) => total + quote.properties.amount, 0)
  const counts = useMemo(
    () =>
      Object.fromEntries(
        views.map(([id]) => [id, allRows.filter((quote) => matchesView(quote, id)).length])
      ),
    [allRows]
  )
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

  function reviewFor(quote: QuoteRow): Intervention | undefined {
    return pendingReviews.find(
      (intervention) =>
        text(intervention.input.caseNumber) === quote.links.serviceCase?.properties.number
    )
  }

  function approveReview(intervention: Intervention, response: InterventionResponse) {
    setSubmittingId(intervention.id)
    submit.mutate({
      path: { interventionId: intervention.id },
      body: { response },
    })
  }

  function reviewState(intervention: Intervention | undefined) {
    return {
      pending: submit.isPending && submittingId === intervention?.id,
      failed: submit.isError && submit.variables?.path.interventionId === intervention?.id,
    }
  }

  if (selectedId !== null) {
    const quote = allRows.find((row) => row.primaryId === selectedId)
    const review = quote ? reviewFor(quote) : undefined
    return (
      <QuoteDocumentPage number={quote?.properties.number}>
        <QueryState
          loading={quotes.isLoading || reviews.isLoading}
          error={quotes.isError || reviews.isError}
          empty={!quote}
          emptyMessage="Quote not found."
        >
          {quote ? (
            <QuoteDocument
              quote={quote}
              serviceCase={caseRows.find(
                (serviceCase) => serviceCase.primaryId === quote.links.serviceCase?.primaryId
              )}
              review={review}
              {...reviewState(review)}
              onApproveReview={(response) => {
                if (review) approveReview(review, response)
              }}
            />
          ) : null}
        </QueryState>
      </QuoteDocumentPage>
    )
  }

  return (
    <div>
      <PageHeader
        title="Quotes"
        description={
          <>
            Repair proposals and the customer decisions they unblock.
            {blockedValue > 0 ? (
              <>
                {" "}
                <span className="font-medium text-foreground tabular-nums">
                  {formatMoney(blockedValue)}
                </span>{" "}
                is waiting on a decision.
              </>
            ) : null}
          </>
        }
        action={
          <>
            <SearchField
              label="Search quotes"
              value={search}
              onChange={setSearch}
              placeholder="Search quotes, customers, cases"
            />
            <SortSelect label="Sort quotes" value={sort} options={sortOptions} onChange={setSort} />
          </>
        }
      >
        <ViewPills
          label="Quote views"
          views={views}
          value={view}
          counts={counts}
          onChange={setView}
        />
      </PageHeader>

      {unmatchedReviews.length > 0 ? (
        <div className="mb-5 flex flex-col gap-4">
          {unmatchedReviews.map((intervention) => (
            <ReviewCard
              key={intervention.id}
              intervention={intervention}
              serviceCase={caseForReview(intervention, caseRows)}
              {...reviewState(intervention)}
              onApprove={(response) => approveReview(intervention, response)}
            />
          ))}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
        <QueryState
          loading={quotes.isLoading || reviews.isLoading}
          error={quotes.isError || reviews.isError}
          empty={visibleRows.length === 0}
          emptyMessage={search ? "No quotes match that search." : "No quotes in this view."}
        >
          <ul>
            {visibleRows.map((quote) => (
              <QuoteListRow
                key={quote.primaryId}
                quote={quote}
                awaitingApproval={Boolean(reviewFor(quote))}
              />
            ))}
          </ul>
        </QueryState>
      </section>
    </div>
  )
}

function QuoteListRow({ quote, awaitingApproval }: { quote: QuoteRow; awaitingApproval: boolean }) {
  const status = quote.properties.status
  const open = isOpen(status)
  const caseNumber = quote.links.serviceCase?.properties.number

  return (
    <li className="border-t border-border/70 first:border-t-0">
      <Link
        to={quotePath(quote.primaryId)}
        className="group grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none max-sm:grid-cols-1 max-sm:gap-2.5 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto_1rem] sm:px-6 dark:hover:bg-white/[0.03]"
      >
        {/* On a phone the amount, state and validity become one line under the scope. */}
        <span className="hidden size-11 items-center justify-center rounded-[12px] bg-muted sm:flex">
          <FileText className="size-5 text-foreground/55" strokeWidth={1.6} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[13px] font-semibold text-muted-foreground tabular-nums">
            {quote.properties.number}
            {caseNumber ? ` · ${caseNumber}` : ""}
          </span>
          <span
            className={cn(
              "line-clamp-2 text-[16px] leading-[1.3] font-semibold tracking-[-0.01em] text-pretty group-hover:text-primary",
              !open && "text-foreground/60"
            )}
          >
            {headline(quote.properties.scope)}
          </span>
          <span className="truncate text-[13.5px] text-muted-foreground">
            {quote.links.customer?.properties.name ?? "Customer"} ·{" "}
            {quote.links.facility?.properties.name ?? "Facility"}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1.5 max-sm:flex-row max-sm:flex-wrap max-sm:items-center max-sm:gap-2.5">
          <span className="text-[16px] font-semibold tracking-[-0.01em] tabular-nums">
            {formatMoney(quote.properties.amount)}
          </span>
          <StatusBadge
            value={status}
            label={awaitingApproval ? "Needs approval" : statusLabel(status)}
          />
          <span
            className={cn(
              "text-[13px] whitespace-nowrap tabular-nums max-sm:ml-auto",
              expiresSoon(quote)
                ? "font-medium text-[color:var(--warning)]"
                : "text-muted-foreground"
            )}
          >
            {validityLabel(quote)}
          </span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground max-sm:hidden" />
      </Link>
    </li>
  )
}

/** A repair scope that has no quote record yet: Northline approves it before it is sent. */
function ReviewCard({
  intervention,
  serviceCase,
  pending,
  failed,
  onApprove,
}: {
  intervention: Intervention
  serviceCase: ServiceCaseRow | undefined
  pending: boolean
  failed: boolean
  onApprove(response: InterventionResponse): void
}) {
  const scope = text(intervention.defaultResponse.scope ?? intervention.input.scope)
  const amount = numeric(intervention.defaultResponse.amount ?? intervention.input.amount)
  const caseNumber = text(intervention.input.caseNumber) || serviceCase?.properties.number
  const caseId = refId(intervention.input.serviceCase) ?? serviceCase?.primaryId
  const validUntil = text(intervention.input.validUntil)
  const customer = serviceCase?.links.customer?.properties.name

  return (
    <section className={decisionCardClass}>
      <div className="flex items-start justify-between gap-6 max-sm:flex-col max-sm:gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-semibold text-primary">Needs your approval</span>
          <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.015em] text-balance">
            {scope ? headline(scope) : "Repair quote review"}
          </h2>
          <p className="max-w-2xl text-[15px] leading-6 text-pretty text-foreground/75">
            Approve the scope and price before the quote goes to {customer ?? "the customer"} for
            authorization.
          </p>
        </div>
        <span className="shrink-0 text-[28px] leading-8 font-semibold tracking-[-0.02em] tabular-nums">
          {formatMoney(amount)}
        </span>
      </div>
      <dl className="flex flex-wrap gap-x-9 gap-y-3">
        {caseNumber ? (
          <Fact label="Service case">
            {caseId ? (
              <Link to={casePath(caseId)} className="text-primary hover:underline">
                {caseNumber}
              </Link>
            ) : (
              caseNumber
            )}
          </Fact>
        ) : null}
        {customer ? <Fact label="Customer">{customer}</Fact> : null}
        {serviceCase?.links.equipment ? (
          <Fact label="Equipment">{serviceCase.links.equipment.properties.name}</Fact>
        ) : null}
        {validUntil ? <Fact label="Valid until">{formatDate(validUntil)}</Fact> : null}
      </dl>
      {text(intervention.input.reason) ? (
        <p className="rounded-[12px] bg-muted px-4 py-3 text-[14px] leading-5 text-foreground/80">
          {text(intervention.input.reason)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2.5">
        <PrimaryButton
          disabled={pending || !scope || amount <= 0}
          onClick={() => onApprove({ scope, amount })}
        >
          {pending ? "Sending…" : "Approve and send"}
        </PrimaryButton>
        {caseId && caseNumber ? (
          <SecondaryLink to={casePath(caseId)}>Open {caseNumber}</SecondaryLink>
        ) : null}
      </div>
      {failed ? <ErrorLine>The approval could not be sent. Try again.</ErrorLine> : null}
    </section>
  )
}

function QuoteDocumentPage({
  number: quoteNumber,
  children,
}: {
  number: string | undefined
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  // The document replaces the list in place, so bring its top into view when it opens.
  useEffect(() => {
    root.current?.scrollIntoView({ block: "start" })
  }, [])

  return (
    <div ref={root} className="flex scroll-mt-14 flex-col gap-4 md:scroll-mt-10">
      <nav className="flex items-center gap-2 text-[14px] text-muted-foreground">
        <Link to="/quotes" className="text-primary hover:underline">
          Quotes
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="tabular-nums">{quoteNumber ?? "Quote"}</span>
      </nav>
      {children}
    </div>
  )
}

function QuoteDocument({
  quote,
  serviceCase,
  review,
  pending: reviewPending,
  failed: reviewFailed,
  onApproveReview,
}: {
  quote: QuoteRow
  serviceCase: ServiceCaseRow | undefined
  review: Intervention | undefined
  pending: boolean
  failed: boolean
  onApproveReview(response: InterventionResponse): void
}) {
  const decide = useActionRunMutation<{
    serviceCase: { objectTypeId: "ServiceCase"; primaryId: string }
    decision: QuoteDecision
  }>({
    actionId: "record-quote-decision",
    subject: { objectType: Quote, primaryId: quote.primaryId },
    invalidateOnCommit: true,
  })
  const { properties } = quote
  const customer = quote.links.customer
  const facility = quote.links.facility
  const linkedCase = quote.links.serviceCase
  const canRecordDecision = Boolean(linkedCase) && isOpen(properties.status)
  const decided = properties.status === "approved" || properties.status === "declined"

  let next: ReactNode = null
  if (review) {
    const scope = text(review.defaultResponse.scope ?? review.input.scope)
    const amount = numeric(review.defaultResponse.amount ?? review.input.amount)
    next = (
      <section className={decisionCardClass}>
        <NextStepHeading
          title="Approve the quote for customer authorization"
          detail={`Confirm the repair scope and ${formatMoney(amount)} price before the quote is sent to ${customer?.properties.name ?? "the customer"}.`}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <PrimaryButton
            disabled={reviewPending || !scope || amount <= 0}
            onClick={() => onApproveReview({ scope, amount })}
          >
            {reviewPending ? "Sending…" : "Approve and send"}
          </PrimaryButton>
        </div>
        {reviewFailed ? <ErrorLine>The approval could not be sent. Try again.</ErrorLine> : null}
      </section>
    )
  } else if (canRecordDecision && linkedCase) {
    const recording = decide.isPending ? decide.variables?.decision : undefined
    const record = (decision: QuoteDecision) =>
      decide.mutate({
        serviceCase: { objectTypeId: "ServiceCase", primaryId: linkedCase.primaryId },
        decision,
      })
    next = (
      <section className={decisionCardClass}>
        <NextStepHeading
          title="Record the customer’s decision"
          detail={`Did ${customer?.properties.name ?? "the customer"} approve the ${formatMoney(properties.amount)} repair? Approved work goes back to dispatch; a declined repair resolves ${linkedCase.properties.number}.`}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <PrimaryButton disabled={decide.isPending} onClick={() => record("approved")}>
            {recording === "approved" ? "Saving…" : "Customer approved"}
          </PrimaryButton>
          <SecondaryButton disabled={decide.isPending} onClick={() => record("declined")}>
            {recording === "declined" ? "Saving…" : "Customer declined"}
          </SecondaryButton>
        </div>
        {decide.isError ? (
          <ErrorLine>The decision could not be recorded. Try again.</ErrorLine>
        ) : null}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-6 max-md:flex-col max-md:gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] tabular-nums sm:text-[40px]">
              {properties.number}
            </h1>
            <p className="text-[16px] text-muted-foreground">
              Repair quote for {customer?.properties.name ?? "the customer"}
              {facility ? ` · ${facility.properties.name}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-2">
            <StatusBadge
              value={properties.status}
              label={review ? "Needs approval" : statusLabel(properties.status)}
            />
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-9 gap-y-3 pt-1">
          <Fact label="Amount">{formatMoney(properties.amount)}</Fact>
          <Fact label="Valid until">
            <span className={cn(expiresSoon(quote) && "text-[color:var(--warning)]")}>
              {formatDate(properties.validUntil)}
              {isOpen(properties.status) ? ` · ${remainingLabel(properties.validUntil)}` : ""}
            </span>
          </Fact>
          <Fact label="Service case">
            {linkedCase ? (
              <Link to={casePath(linkedCase.primaryId)} className="text-primary hover:underline">
                {linkedCase.properties.number}
              </Link>
            ) : (
              "None"
            )}
          </Fact>
          {decided ? (
            <Fact label="Decided">{formatDate(properties.decisionAt)}</Fact>
          ) : properties.sourceUpdatedAt ? (
            <Fact label={properties.status === "sent" ? "Sent" : "Updated"}>
              {formatRelativeTime(properties.sourceUpdatedAt)}
            </Fact>
          ) : null}
        </dl>
      </header>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          {next}

          <section
            aria-label={`Quote ${properties.number}`}
            className="rounded-[20px] bg-card shadow-[var(--shadow-card)]"
          >
            <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-5 sm:px-8">
              <div className="flex flex-col gap-0.5">
                <span className="text-[17px] font-semibold tracking-[-0.015em]">
                  Northline Mechanical
                </span>
                <span className="text-[13.5px] text-muted-foreground">Repair quote</span>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-right">
                <span className="text-[15px] font-semibold tabular-nums">{properties.number}</span>
                {properties.sourceUpdatedAt ? (
                  <span className="text-[13.5px] text-muted-foreground tabular-nums">
                    {formatDate(properties.sourceUpdatedAt)}
                  </span>
                ) : null}
              </div>
            </div>

            <DocumentPart label="Prepared for">
              <p className="text-[16px] font-semibold">{customer?.properties.name ?? "Customer"}</p>
              {facility ? (
                <p className="text-[14px] leading-5 text-foreground/80">
                  {facility.properties.name} · {facility.properties.addressLine},{" "}
                  {facility.properties.city}, {facility.properties.state}{" "}
                  {facility.properties.postalCode}
                </p>
              ) : null}
              {customer?.properties.primaryContactName ? (
                <p className="text-[14px] leading-5 text-muted-foreground">
                  Attention {customer.properties.primaryContactName}
                </p>
              ) : null}
            </DocumentPart>

            <DocumentPart label="Scope of work">
              <p className="text-[16px] leading-[1.55] text-pretty">{properties.scope}</p>
            </DocumentPart>

            <DocumentPart label="Why it needs authorization">
              <p className="text-[15px] leading-[1.55] text-pretty text-foreground/80">
                {properties.reason}
              </p>
            </DocumentPart>

            <div className="mx-6 flex items-end justify-between gap-4 border-t border-border/70 pt-5 pb-6 sm:mx-8">
              <div className="flex flex-col gap-0.5">
                <span className="text-[15px] font-semibold">Total</span>
                <span className="text-[13.5px] text-muted-foreground">
                  {properties.currency} · valid until {formatDate(properties.validUntil)}
                </span>
              </div>
              <span className="text-[30px] leading-9 font-semibold tracking-[-0.02em] tabular-nums">
                {formatMoney(properties.amount)}
              </span>
            </div>
          </section>
        </div>

        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
          {linkedCase ? (
            <Section
              title="Service case"
              action={
                <Link
                  to={casePath(linkedCase.primaryId)}
                  className="font-medium text-primary hover:underline"
                >
                  Open
                </Link>
              }
            >
              <div className="flex flex-col gap-2 px-6 pb-5">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 text-[15px] leading-5 font-semibold">
                    {linkedCase.properties.number} · {linkedCase.properties.title}
                  </span>
                  <StatusBadge
                    value={serviceCase?.properties.status ?? linkedCase.properties.status}
                  />
                </div>
                <span className="text-[13.5px] leading-5 text-muted-foreground">
                  {[serviceCase?.links.equipment?.properties.name, linkedCase.properties.nextAction]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            </Section>
          ) : null}

          {customer ? (
            <Section
              title="Customer"
              action={
                <Link
                  to={`/customers/${encodeURIComponent(customer.primaryId)}`}
                  className="font-medium text-primary hover:underline"
                >
                  Open
                </Link>
              }
            >
              <dl className="flex flex-col px-6 pb-4">
                <Row label={customer.properties.name}>
                  {humanize(customer.properties.serviceTier)}
                </Row>
                {customer.properties.primaryContactName ? (
                  <Row label={customer.properties.primaryContactName}>Primary contact</Row>
                ) : null}
                {facility ? (
                  <Row label={facility.properties.name}>
                    {facility.properties.city}, {facility.properties.state}
                  </Row>
                ) : null}
              </dl>
            </Section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function NextStepHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-semibold text-primary">Next step</span>
      <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">{title}</h2>
      <p className="max-w-2xl text-[15px] leading-6 text-pretty text-foreground/75">{detail}</p>
    </div>
  )
}

function DocumentPart({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mx-6 flex flex-col gap-1.5 border-t border-border/70 py-5 sm:mx-8">
      <h3 className="text-[12.5px] font-semibold text-muted-foreground">{label}</h3>
      {children}
    </div>
  )
}

const primaryClass =
  "inline-flex h-10 items-center rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
const secondaryClass =
  "inline-flex h-10 items-center rounded-full bg-black/[0.05] px-5 text-[14px] font-semibold text-foreground transition-colors hover:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 dark:bg-white/[0.08] dark:hover:bg-white/[0.12]"

function PrimaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean
  onClick(): void
  children: ReactNode
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={primaryClass}>
      {children}
    </button>
  )
}

function SecondaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean
  onClick(): void
  children: ReactNode
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={secondaryClass}>
      {children}
    </button>
  )
}

function SecondaryLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={secondaryClass}>
      {children}
    </Link>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-[13.5px] text-destructive">
      {children}
    </p>
  )
}

function caseForReview(
  intervention: Intervention,
  cases: readonly ServiceCaseRow[]
): ServiceCaseRow | undefined {
  const caseId = refId(intervention.input.serviceCase)
  const caseNumber = text(intervention.input.caseNumber)
  return (
    cases.find((serviceCase) => serviceCase.primaryId === caseId) ??
    cases.find((serviceCase) => serviceCase.properties.number === caseNumber)
  )
}

function matchesView(quote: QuoteRow, view: View): boolean {
  if (view === "all") return true
  if (view === "expiring") {
    return isOpen(quote.properties.status) && daysUntil(quote.properties.validUntil) <= 7
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

/** Quotes still waiting on a decision, from Northline or from the customer. */
function isOpen(status: string): boolean {
  return status === "internal_review" || status === "sent"
}

function expiresSoon(quote: QuoteRow): boolean {
  return isOpen(quote.properties.status) && daysUntil(quote.properties.validUntil) <= 7
}

function statusLabel(status: string): string {
  return status === "sent" ? "With customer" : humanize(status)
}

function validityLabel(quote: QuoteRow): string {
  const { status, decisionAt, validUntil } = quote.properties
  if (status === "approved" || status === "declined") {
    return decisionAt ? `${humanize(status)} ${formatDate(decisionAt)}` : humanize(status)
  }
  if (status === "expired" || daysUntil(validUntil) < 0) return `Expired ${formatDate(validUntil)}`
  if (isOpen(status) && daysUntil(validUntil) <= 7) return remainingLabel(validUntil)
  return `Valid until ${formatDate(validUntil)}`
}

function remainingLabel(value: string | Date | undefined): string {
  const days = daysUntil(value)
  if (days < 0) return "Expired"
  if (days === 0) return "Expires today"
  if (days === 1) return "1 day left"
  return `${days} days left`
}

function headline(scope: string): string {
  return scope.replace(/\.$/, "")
}

function casePath(primaryId: string): string {
  return `/service-cases/${encodeURIComponent(primaryId)}`
}

function dateValue(value: string | Date | undefined): number {
  return value ? new Date(value).getTime() : Number.POSITIVE_INFINITY
}

function refId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("primaryId" in value)) return undefined
  return typeof value.primaryId === "string" ? value.primaryId : undefined
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : 0
}
