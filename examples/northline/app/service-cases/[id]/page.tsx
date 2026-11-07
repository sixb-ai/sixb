import { useCurrentUser } from "@sixb/app"
import { useActionRunMutation, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import {
  Check,
  ChevronRight,
  ClipboardCheck,
  FileText,
  Radio,
  ShieldCheck,
  Truck,
  Wrench,
} from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { FieldNote } from "../../../ontology/field-note"
import { Quote } from "../../../ontology/quote"
import { ServiceCase } from "../../../ontology/service-case"
import { ServiceVisit } from "../../../ontology/service-visit"
import { WorkOrder } from "../../../ontology/work-order"
import { ErrorLine, NextStepCard, PillButton, PillLink } from "../../_components/next-step"
import { StageRail } from "../../_components/stage-rail"
import { Timeline, type TimelineEntry } from "../../_components/timeline"
import {
  CaseClockText,
  Fact,
  formatCoverageHours,
  formatDateTime,
  formatMinutes,
  formatMoney,
  formatRelativeTime,
  humanize,
  QueryState,
  Row,
  Section,
  StatusBadge,
  StatusIndicator,
} from "../../_components/ui"
import { equipmentIllustration } from "../../_lib/equipment"
import type { QueryRow } from "../../_lib/query-types"
import { isQuoteOpen, quotePath } from "../../_lib/quotes"
import { caseClock, caseDecision, isCaseOpen } from "../../_lib/service-cases"

const serviceCaseBase = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .expand(ServiceCase.l.appliedContract)
  .expand(ServiceCase.l.originatingAlarms)

// The case's own records, each followed from the case by the server.
function caseWorkOrders(caseId: string) {
  return objects(ServiceCase)
    .query()
    .where((serviceCase) => serviceCase.p.id.eq(caseId))
    .traverse(WorkOrder.l.serviceCase, { direction: "incoming" })
}

function workOrdersQuery(caseId: string) {
  return caseWorkOrders(caseId)
    .expand(WorkOrder.l.equipment)
    .expand(WorkOrder.l.assignee)
    .limit(100)
}

function visitsQuery(caseId: string) {
  return caseWorkOrders(caseId)
    .traverse(ServiceVisit.l.workOrder, { direction: "incoming" })
    .expand(ServiceVisit.l.workOrder)
    .expand(ServiceVisit.l.technician)
    .limit(100)
}

function notesQuery(caseId: string) {
  return caseWorkOrders(caseId)
    .traverse(ServiceVisit.l.workOrder, { direction: "incoming" })
    .traverse(FieldNote.l.visit, { direction: "incoming" })
    .expand(FieldNote.l.visit)
    .expand(FieldNote.l.author)
    .limit(100)
}

function quotesQuery(caseId: string) {
  return objects(ServiceCase)
    .query()
    .where((serviceCase) => serviceCase.p.id.eq(caseId))
    .traverse(Quote.l.serviceCase, { direction: "incoming" })
    .expand(Quote.l.originatingVisit)
    .limit(100)
}

type ServiceCaseRow = QueryRow<typeof serviceCaseBase>
type WorkOrderRow = QueryRow<ReturnType<typeof workOrdersQuery>>
type VisitRow = QueryRow<ReturnType<typeof visitsQuery>>
type NoteRow = QueryRow<ReturnType<typeof notesQuery>>
type QuoteRow = QueryRow<ReturnType<typeof quotesQuery>>

const stages = [
  { id: "new", label: "New" },
  { id: "triage", label: "Triage" },
  { id: "dispatching", label: "Dispatch" },
  { id: "in_service", label: "In service" },
  { id: "awaiting_authorization", label: "Authorization" },
  { id: "resolved", label: "Resolved" },
  { id: "closed", label: "Closed" },
]

export default function ServiceCaseDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const user = useCurrentUser()
  const caseQuery = useMemo(
    () => serviceCaseBase.where((serviceCase) => serviceCase.p.id.eq(id)),
    [id]
  )
  const serviceCaseResult = useObjectsQuery(caseQuery)
  const workOrdersResult = useObjectsQuery(useMemo(() => workOrdersQuery(id), [id]))
  const visitsResult = useObjectsQuery(useMemo(() => visitsQuery(id), [id]))
  const notesResult = useObjectsQuery(useMemo(() => notesQuery(id), [id]))
  const quotesResult = useObjectsQuery(useMemo(() => quotesQuery(id), [id]))
  const serviceCase = serviceCaseResult.data?.objects[0]
  const workOrders = workOrdersResult.data?.objects ?? []
  const visits = visitsResult.data?.objects ?? []
  const notes = notesResult.data?.objects ?? []
  const quotes = quotesResult.data?.objects ?? []
  const openQuote = quotes.find((quote) => isQuoteOpen(quote.properties.status))

  const acknowledge = useActionRunMutation<{ operatorName?: string }>({
    actionId: "acknowledge-service-case",
    subject: { objectType: ServiceCase, primaryId: id },
    invalidateOnCommit: true,
  })
  const verify = useActionRunMutation<{
    equipment: { objectTypeId: "Equipment"; primaryId: string }
  }>({
    actionId: "verify-equipment-recovery",
    subject: { objectType: ServiceCase, primaryId: id },
    invalidateOnCommit: true,
  })
  const close = useActionRunMutation<{ summary?: string }>({
    actionId: "close-service-case",
    subject: { objectType: ServiceCase, primaryId: id },
    invalidateOnCommit: true,
  })

  const assignedWorkOrder = workOrders.find((workOrder) => workOrder.links.assignee)
  const assignedTechnician = assignedWorkOrder?.links.assignee
  const currentVisit =
    visits.find((visit) => visit.primaryId === serviceCase?.properties.currentVisitId) ?? visits[0]
  const workspaceHref = assignedTechnician
    ? `/technicians/${encodeURIComponent(assignedTechnician.primaryId)}${
        currentVisit ? `?visit=${encodeURIComponent(currentVisit.primaryId)}` : ""
      }`
    : undefined
  const latestDiagnosis = [...notes]
    .filter((note) => note.properties.noteType === "diagnostic")
    .sort((left, right) => time(right.properties.recordedAt) - time(left.properties.recordedAt))[0]

  const status = serviceCase?.properties.status
  const clock = caseClock(serviceCase?.properties ?? {})
  const decision = caseDecision(
    status,
    workOrders.some((workOrder) => workOrder.properties.status === "completed")
  )
  const equipmentId = serviceCase?.links.equipment?.primaryId
  let next: NextStep | null = null
  if (serviceCase && decision === "Acknowledge") {
    next = {
      title: "Acknowledge the case",
      detail: "Take ownership so the response clock is covered and dispatch can begin.",
      primary: (
        <PillButton
          disabled={acknowledge.isPending}
          // Signed out, the action records the dispatch desk as the owner.
          onClick={() => acknowledge.mutate({ operatorName: user?.displayName })}
        >
          {acknowledge.isPending ? "Acknowledging…" : "Acknowledge"}
        </PillButton>
      ),
      error: acknowledge.isError ? "The case could not be acknowledged. Try again." : undefined,
    }
  } else if (serviceCase && decision === "Dispatch") {
    next = {
      title: "Review the dispatch recommendation",
      detail:
        serviceCase.properties.nextAction ??
        "Pick the technician and window that meet the response target.",
      primary: <PillLink to="/dispatch">Review dispatch</PillLink>,
    }
  } else if (serviceCase && decision === "Review quote") {
    next = {
      title: "Review the repair quote",
      detail: "The repair falls outside contract coverage and needs customer authorization.",
      primary: (
        <PillLink to={openQuote ? quotePath(openQuote.primaryId) : "/quotes"}>
          Review quote
        </PillLink>
      ),
    }
  } else if (serviceCase && decision === "Verify recovery" && equipmentId) {
    next = {
      title: "Verify the equipment recovered",
      detail: "Field work is complete. Confirm the readings are back in range before resolving.",
      primary: (
        <PillButton
          disabled={verify.isPending}
          onClick={() =>
            verify.mutate({ equipment: { objectTypeId: "Equipment", primaryId: equipmentId } })
          }
        >
          {verify.isPending ? "Verifying…" : "Verify recovery"}
        </PillButton>
      ),
      error: verify.isError ? "Recovery could not be verified. Try again." : undefined,
    }
  } else if (serviceCase && decision === "Close") {
    next = {
      title: "Close the case",
      detail: serviceCase.properties.resolutionSummary ?? "Recovery is verified.",
      primary: (
        <PillButton
          disabled={close.isPending}
          onClick={() => close.mutate({ summary: serviceCase.properties.resolutionSummary })}
        >
          {close.isPending ? "Closing…" : "Close case"}
        </PillButton>
      ),
      error: close.isError ? "The case could not be closed. Try again." : undefined,
    }
  } else if (serviceCase && workspaceHref && isCaseOpen(status)) {
    next = {
      title: "Follow the field work",
      detail: serviceCase.properties.nextAction ?? "The technician is working the case.",
      primary: <PillLink to={workspaceHref}>Open field workspace</PillLink>,
    }
  }
  // A decision can also open the field workspace; following the field work already does.
  const workspaceAside = decision !== undefined && workspaceHref

  return (
    <QueryState
      loading={serviceCaseResult.isLoading}
      error={serviceCaseResult.isError}
      empty={!serviceCase}
      emptyMessage="Service case not found."
    >
      {serviceCase ? (
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-4">
            <nav className="flex items-center gap-2 text-[14px] text-muted-foreground">
              <Link to="/service-cases" className="text-primary hover:underline">
                Service cases
              </Link>
              <ChevronRight className="size-3.5" />
              <span className="tabular-nums">{serviceCase.properties.number}</span>
            </nav>
            <div className="flex items-start justify-between gap-6 max-md:flex-col max-md:gap-3">
              <div className="flex min-w-0 flex-col gap-2">
                <h1 className="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[40px]">
                  {caseHeadline(
                    serviceCase.properties.title ?? "",
                    serviceCase.links.equipment?.properties.name
                  )}
                </h1>
                <p className="text-[16px] text-muted-foreground">
                  {serviceCase.links.customer?.properties.name} ·{" "}
                  {serviceCase.links.facility?.properties.name} ·{" "}
                  {serviceCase.links.equipment?.properties.name}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-2">
                <StatusBadge value={serviceCase.properties.severity} />
                <StatusBadge value={serviceCase.properties.status} />
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-9 gap-y-3 pt-1">
              <Fact label={clock.label}>
                <CaseClockText serviceCase={serviceCase.properties} variant="value" />
              </Fact>
              {Number.isFinite(clock.dueAt) ? (
                <Fact label="Resolve by">
                  {formatDateTime(serviceCase.properties.resolutionDeadline)}
                </Fact>
              ) : null}
              <Fact label="Coverage">
                {humanize(serviceCase.properties.coverageStatus ?? "unknown")}
              </Fact>
              <Fact label="Owner">{serviceCase.properties.ownerName ?? "Unassigned"}</Fact>
              <Fact label="Detected">{formatRelativeTime(serviceCase.properties.detectedAt)}</Fact>
            </dl>
            <StageRail
              stages={stages}
              current={status === "cancelled" ? "closed" : (status ?? "new")}
            />
          </header>

          <div className="flex flex-wrap items-start gap-5">
            <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
              {next ? (
                <NextStepCard title={next.title} detail={next.detail}>
                  <div className="flex flex-wrap items-center gap-2.5">
                    {next.primary}
                    {workspaceAside ? (
                      <PillLink to={workspaceAside} tone="secondary">
                        Field workspace
                      </PillLink>
                    ) : null}
                  </div>
                  {next.error ? <ErrorLine>{next.error}</ErrorLine> : null}
                </NextStepCard>
              ) : null}

              {latestDiagnosis ? <Diagnosis note={latestDiagnosis} /> : null}

              <Section
                title="Everything about this case"
                description="Building controls, field service and the business system, in one place"
              >
                <Timeline
                  entries={timelineEntries(serviceCase, workOrders, visits, notes, quotes)}
                />
              </Section>
            </div>

            <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
              <EquipmentCard serviceCase={serviceCase} />
              <CustomerCard serviceCase={serviceCase} />
              <WorkCard
                workOrders={workOrders}
                visits={visits}
                quotes={quotes}
                workspaceHref={workspaceHref}
              />
              <ContractCard serviceCase={serviceCase} />
            </aside>
          </div>
        </div>
      ) : null}
    </QueryState>
  )
}

interface NextStep {
  readonly title: string
  readonly detail: string
  readonly primary: ReactNode
  /** Why the primary action did not go through. */
  readonly error?: string
}

function Diagnosis({ note }: { note: NoteRow }) {
  return (
    <Section
      title="Field diagnosis"
      description={`${note.links.author?.properties.name ?? "Technician"} · ${formatRelativeTime(note.properties.recordedAt)}`}
    >
      <p className="px-6 pb-6 text-[15.5px] leading-[1.6] text-pretty">{note.properties.body}</p>
    </Section>
  )
}

function EquipmentCard({ serviceCase }: { serviceCase: ServiceCaseRow }) {
  const equipment = serviceCase.links.equipment
  if (!equipment) return null
  const illustration = equipmentIllustration(
    equipment.properties.name,
    equipment.properties.equipmentType
  )
  return (
    <section className="overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
      {illustration ? (
        <div className="flex h-44 items-center justify-center bg-muted">
          <img
            src={illustration.src}
            alt={`${equipment.properties.name} illustration`}
            className={cn(
              "size-full",
              illustration.contain ? "object-contain p-4" : "object-cover"
            )}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-3 px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold tracking-[-0.015em]">
              {equipment.properties.name}
            </h2>
            <p className="text-[13.5px] text-muted-foreground">
              {[equipment.properties.manufacturer, equipment.properties.model]
                .filter(Boolean)
                .join(" ")}
            </p>
          </div>
          <StatusIndicator value={equipment.properties.health} />
        </div>
        {equipment.properties.healthReason ? (
          <p className="text-[14px] leading-5 text-foreground/80">
            {humanize(equipment.properties.healthReason)}
          </p>
        ) : null}
        <Link
          to={`/equipment/${encodeURIComponent(equipment.primaryId)}`}
          className="text-[14px] font-medium text-primary hover:underline"
        >
          Readings and history
        </Link>
      </div>
    </section>
  )
}

function CustomerCard({ serviceCase }: { serviceCase: ServiceCaseRow }) {
  const customer = serviceCase.links.customer
  const facility = serviceCase.links.facility
  return (
    <Section title="Customer">
      <dl className="flex flex-col px-6 pb-4">
        {customer ? (
          <Row label={customer.properties.name ?? "Customer"}>
            <Link
              to={`/customers/${encodeURIComponent(customer.primaryId)}`}
              className="text-primary hover:underline"
            >
              {humanize(customer.properties.serviceTier ?? "standard")}
            </Link>
          </Row>
        ) : null}
        {customer?.properties.primaryContactName ? (
          <Row label={customer.properties.primaryContactName}>Primary contact</Row>
        ) : null}
        {facility ? (
          <Row label={facility.properties.name ?? "Facility"}>
            {[facility.properties.city, facility.properties.state].filter(Boolean).join(", ")}
          </Row>
        ) : null}
      </dl>
      {facility?.properties.accessNotes ? (
        <p className="mx-6 mb-5 rounded-[12px] bg-muted px-3.5 py-3 text-[13.5px] leading-5 text-foreground/80">
          {facility.properties.accessNotes}
        </p>
      ) : null}
    </Section>
  )
}

function WorkCard({
  workOrders,
  visits,
  quotes,
  workspaceHref,
}: {
  workOrders: readonly WorkOrderRow[]
  visits: readonly VisitRow[]
  quotes: readonly QuoteRow[]
  workspaceHref: string | undefined
}) {
  if (workOrders.length === 0 && quotes.length === 0) return null
  return (
    <Section
      title="Field work"
      action={
        workspaceHref ? (
          <Link to={workspaceHref} className="font-medium text-primary hover:underline">
            Workspace
          </Link>
        ) : undefined
      }
    >
      <ul className="flex flex-col px-6 pb-3">
        {workOrders.map((workOrder) => (
          <li
            key={workOrder.primaryId}
            className="flex items-center justify-between gap-3 border-t border-border/70 py-3 first:border-t-0"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[14.5px] font-medium">
                {workOrder.properties.number}
              </span>
              <span className="truncate text-[12.5px] text-muted-foreground">
                {workOrder.links.assignee?.properties.name ?? "Unassigned"} ·{" "}
                {
                  visits.filter((visit) => visit.links.workOrder?.primaryId === workOrder.primaryId)
                    .length
                }{" "}
                visit(s)
              </span>
            </span>
            <StatusBadge value={workOrder.properties.status} />
          </li>
        ))}
        {quotes.map((quote) => (
          <li
            key={quote.primaryId}
            className="flex items-center justify-between gap-3 border-t border-border/70 py-3 first:border-t-0"
          >
            <Link
              to={quotePath(quote.primaryId)}
              className="flex min-w-0 flex-col hover:text-primary"
            >
              <span className="truncate text-[14.5px] font-medium">
                {quote.properties.number} · {formatMoney(quote.properties.amount)}
              </span>
              <span className="truncate text-[12.5px] text-muted-foreground">Repair quote</span>
            </Link>
            <StatusBadge value={quote.properties.status} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function ContractCard({ serviceCase }: { serviceCase: ServiceCaseRow }) {
  const contract = serviceCase.links.appliedContract
  if (!contract) return null
  return (
    <Section title="Contract">
      <dl className="flex flex-col px-6 pb-4">
        <Row label={contract.properties.name ?? "Contract"}>{contract.properties.number}</Row>
        <Row label="Response target">
          {contract.properties.responseTargetMinutes
            ? formatMinutes(contract.properties.responseTargetMinutes)
            : "—"}
        </Row>
        <Row label="Hours">{formatCoverageHours(contract.properties.coverageHours)}</Row>
        <Row label="Approval above">{formatMoney(contract.properties.approvalThreshold)}</Row>
      </dl>
    </Section>
  )
}

function timelineEntries(
  serviceCase: ServiceCaseRow,
  workOrders: readonly WorkOrderRow[],
  visits: readonly VisitRow[],
  notes: readonly NoteRow[],
  quotes: readonly QuoteRow[]
): TimelineEntry[] {
  return [
    ...serviceCase.links.originatingAlarms.map((alarm) => ({
      id: `${alarm.primaryId}-observed`,
      at: alarm.properties.observedAt,
      icon: Radio,
      title: "Building controls raised an alarm",
      detail: alarm.properties.message,
      source: "Building controls",
      status: alarm.properties.severity,
      emphasis: true,
    })),
    {
      id: `${serviceCase.primaryId}-created`,
      at: serviceCase.properties.detectedAt,
      icon: Radio,
      title: `${serviceCase.properties.number} opened`,
      detail: serviceCase.properties.customerImpact,
      source: "Northline Operations",
    },
    ...(serviceCase.properties.acknowledgedAt
      ? [
          {
            id: `${serviceCase.primaryId}-acknowledged`,
            at: serviceCase.properties.acknowledgedAt,
            icon: Check,
            title: "Case acknowledged",
            detail: serviceCase.properties.ownerName,
            source: "Northline Operations",
          },
        ]
      : []),
    ...workOrders.map((workOrder) => ({
      id: `${workOrder.primaryId}-dispatch`,
      at: workOrder.properties.dispatchedAt ?? workOrder.properties.scheduledStart,
      icon: Truck,
      title: `${workOrder.properties.number} dispatched to ${workOrder.links.assignee?.properties.name ?? "a technician"}`,
      detail: workOrder.properties.scope,
      source: "Field service",
      status: workOrder.properties.status,
    })),
    ...visits.flatMap((visit) => [
      {
        id: `${visit.primaryId}-start`,
        at: visit.properties.startedAt ?? visit.properties.scheduledStart,
        icon: Wrench,
        title: `${visit.properties.number} ${visit.properties.startedAt ? "started" : "scheduled"}`,
        detail: visit.links.technician?.properties.name,
        source: "Field service",
      },
      ...(visit.properties.completedAt
        ? [
            {
              id: `${visit.primaryId}-complete`,
              at: visit.properties.completedAt,
              icon: ClipboardCheck,
              title: `${visit.properties.number} completed`,
              detail: visit.properties.workPerformed,
              source: "Field service",
              status: visit.properties.completionDisposition,
            },
          ]
        : []),
    ]),
    ...notes.map((note) => ({
      id: note.primaryId,
      at: note.properties.recordedAt,
      icon: FileText,
      title: `${humanize(note.properties.noteType ?? "field")} note`,
      detail: note.properties.body,
      source: note.links.author?.properties.name ?? "Field service",
    })),
    ...quotes.map((quote) => ({
      id: quote.primaryId,
      at: quote.properties.decisionAt ?? quote.properties.sourceUpdatedAt,
      icon: ShieldCheck,
      title: `${quote.properties.number} · ${formatMoney(quote.properties.amount)}`,
      detail: quote.properties.scope,
      source: "Business system",
      status: quote.properties.status,
    })),
    ...(serviceCase.properties.resolvedAt
      ? [
          {
            id: `${serviceCase.primaryId}-resolved`,
            at: serviceCase.properties.resolvedAt,
            icon: Check,
            title: "Equipment recovery verified",
            detail: serviceCase.properties.resolutionSummary,
            source: "Building controls",
            emphasis: true,
          },
        ]
      : []),
  ]
}

function caseHeadline(title: string, equipmentName: string | undefined): string {
  const escapedName = equipmentName?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const withoutEquipment = escapedName
    ? title.replace(new RegExp(`^${escapedName}\\s+(?:entered\\s+)?`, "i"), "")
    : title
  const normalized = withoutEquipment.replaceAll("-", " ").replace(/\.$/, "")
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function time(value: string | Date | undefined): number {
  if (!value) return 0
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}
