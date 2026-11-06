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
import { StageRail } from "../../_components/stage-rail"
import { Timeline, type TimelineEntry } from "../../_components/timeline"
import {
  deadlineLabel,
  formatDateTime,
  formatMoney,
  formatRelativeTime,
  humanize,
  QueryState,
  Section,
  StatusBadge,
  StatusIndicator,
  statusTone,
} from "../../_components/ui"
import { equipmentIllustration } from "../../_lib/equipment"
import type { QueryRow } from "../../_lib/query-types"

const serviceCaseBase = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .expand(ServiceCase.l.appliedContract)
  .expand(ServiceCase.l.originatingAlarms)

const allWorkOrders = objects(WorkOrder)
  .query()
  .expand(WorkOrder.l.serviceCase)
  .expand(WorkOrder.l.equipment)
  .expand(WorkOrder.l.assignee)
  .limit(100)

const allVisits = objects(ServiceVisit)
  .query()
  .expand(ServiceVisit.l.workOrder)
  .expand(ServiceVisit.l.technician)
  .limit(100)

const allNotes = objects(FieldNote)
  .query()
  .expand(FieldNote.l.visit)
  .expand(FieldNote.l.author)
  .limit(100)

const allQuotes = objects(Quote)
  .query()
  .expand(Quote.l.serviceCase)
  .expand(Quote.l.originatingVisit)
  .limit(100)

type ServiceCaseRow = QueryRow<typeof serviceCaseBase>
type WorkOrderRow = QueryRow<typeof allWorkOrders>
type VisitRow = QueryRow<typeof allVisits>
type NoteRow = QueryRow<typeof allNotes>
type QuoteRow = QueryRow<typeof allQuotes>

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
  const caseQuery = useMemo(
    () => serviceCaseBase.where((serviceCase) => serviceCase.p.id.eq(id)),
    [id]
  )
  const serviceCaseResult = useObjectsQuery(caseQuery)
  const workOrdersResult = useObjectsQuery(allWorkOrders)
  const visitsResult = useObjectsQuery(allVisits)
  const notesResult = useObjectsQuery(allNotes)
  const quotesResult = useObjectsQuery(allQuotes)
  const serviceCase = serviceCaseResult.data?.objects[0]
  const workOrders = (workOrdersResult.data?.objects ?? []).filter(
    (workOrder) => workOrder.links.serviceCase?.primaryId === id
  )
  const workOrderIds = new Set(workOrders.map((workOrder) => workOrder.primaryId))
  const visits = (visitsResult.data?.objects ?? []).filter((visit) =>
    workOrderIds.has(visit.links.workOrder?.primaryId ?? "")
  )
  const visitIds = new Set(visits.map((visit) => visit.primaryId))
  const notes = (notesResult.data?.objects ?? []).filter((note) =>
    visitIds.has(note.links.visit?.primaryId ?? "")
  )
  const quotes = (quotesResult.data?.objects ?? []).filter(
    (quote) => quote.links.serviceCase?.primaryId === id
  )

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

  const completedVisit = visits.find((visit) => visit.properties.status === "completed")
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

  let next: NextStep | null = null
  const status = serviceCase?.properties.status
  if (serviceCase && status === "new") {
    next = {
      title: "Acknowledge the case",
      detail: "Take ownership so the response clock is covered and dispatch can begin.",
      primary: (
        <PrimaryButton
          pending={acknowledge.isPending}
          onClick={() => acknowledge.mutate({ operatorName: "Alex Dawson" })}
        >
          {acknowledge.isPending ? "Acknowledging…" : "Acknowledge"}
        </PrimaryButton>
      ),
    }
  } else if (serviceCase && status === "triage") {
    next = {
      title: "Review the dispatch recommendation",
      detail:
        serviceCase.properties.nextAction ??
        "Pick the technician and window that meet the response target.",
      primary: <PrimaryLink to="/dispatch">Review dispatch</PrimaryLink>,
    }
  } else if (serviceCase && status === "awaiting_authorization") {
    next = {
      title: "Review the repair quote",
      detail: "The repair falls outside contract coverage and needs customer authorization.",
      primary: <PrimaryLink to="/quotes">Review quote</PrimaryLink>,
    }
  } else if (
    serviceCase &&
    status === "in_service" &&
    completedVisit &&
    serviceCase.links.equipment
  ) {
    next = {
      title: "Verify the equipment recovered",
      detail: "Field work is complete. Confirm the readings are back in range before resolving.",
      primary: (
        <PrimaryButton
          pending={verify.isPending}
          onClick={() =>
            verify.mutate({
              equipment: {
                objectTypeId: "Equipment",
                primaryId: serviceCase.links.equipment?.primaryId ?? "",
              },
            })
          }
        >
          {verify.isPending ? "Verifying…" : "Verify recovery"}
        </PrimaryButton>
      ),
    }
  } else if (serviceCase && status === "resolved") {
    next = {
      title: "Close the case",
      detail: serviceCase.properties.resolutionSummary ?? "Recovery is verified.",
      primary: (
        <PrimaryButton
          pending={close.isPending}
          onClick={() => close.mutate({ summary: serviceCase.properties.resolutionSummary })}
        >
          {close.isPending ? "Closing…" : "Close case"}
        </PrimaryButton>
      ),
    }
  } else if (serviceCase && workspaceHref && status !== "closed" && status !== "cancelled") {
    next = {
      title: "Follow the field work",
      detail: serviceCase.properties.nextAction ?? "The technician is working the case.",
      primary: <PrimaryLink to={workspaceHref}>Open field workspace</PrimaryLink>,
    }
  }

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
              <Fact label="Response">
                <span className={deadlineClass(serviceCase.properties.slaStatus)}>
                  {["resolved", "closed"].includes(status ?? "")
                    ? humanize(serviceCase.properties.slaStatus ?? "met")
                    : deadlineLabel(serviceCase.properties.responseDeadline)}
                </span>
              </Fact>
              <Fact label="Resolution by">
                {formatDateTime(serviceCase.properties.resolutionDeadline)}
              </Fact>
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
                <section className="flex flex-col gap-4 rounded-[20px] bg-card p-6 shadow-[0_0_0_1.5px_var(--primary),0_10px_28px_color-mix(in_srgb,var(--primary)_12%,transparent)]">
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] font-semibold text-primary">Next step</span>
                    <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
                      {next.title}
                    </h2>
                    <p className="max-w-2xl text-[15px] leading-6 text-foreground/75">
                      {next.detail}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    {next.primary}
                    {workspaceHref && next.title !== "Follow the field work" ? (
                      <Link
                        to={workspaceHref}
                        className="inline-flex h-10 items-center rounded-full bg-black/[0.05] px-5 text-[14px] font-semibold transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08]"
                      >
                        Field workspace
                      </Link>
                    ) : null}
                  </div>
                </section>
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
}

function PrimaryButton({
  pending,
  onClick,
  children,
}: {
  pending: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className="inline-flex h-10 items-center rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
    >
      {children}
    </button>
  )
}

function PrimaryLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex h-10 items-center rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {children}
    </Link>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[14.5px] font-medium tabular-nums">{children}</dd>
    </div>
  )
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
            <Link to="/quotes" className="flex min-w-0 flex-col hover:text-primary">
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
            ? `${contract.properties.responseTargetMinutes} min`
            : "—"}
        </Row>
        <Row label="Hours">{humanize(contract.properties.coverageHours ?? "business_hours")}</Row>
        <Row label="Approval above">{formatMoney(contract.properties.approvalThreshold)}</Row>
      </dl>
    </Section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/70 py-2.5 first:border-t-0">
      <dt className="truncate text-[14.5px] font-medium">{label}</dt>
      <dd className="shrink-0 text-[13.5px] text-muted-foreground">{children}</dd>
    </div>
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

function deadlineClass(slaStatus: string | undefined): string {
  const tone = statusTone(slaStatus)
  if (tone === "critical") return "text-destructive"
  if (tone === "warning") return "text-[color:var(--warning)]"
  return ""
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
