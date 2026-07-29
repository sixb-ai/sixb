import { useActionRunMutation, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Button } from "@sixb/ui/components"
import {
  ArrowLeft,
  Check,
  Circle,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileText,
  type LucideIcon,
  Radio,
  ShieldCheck,
  Timer,
  Truck,
  UserRound,
  Wrench,
} from "lucide-react"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { FieldNote } from "../../../ontology/field-note"
import { Quote } from "../../../ontology/quote"
import { ServiceCase } from "../../../ontology/service-case"
import { ServiceVisit } from "../../../ontology/service-visit"
import { WorkOrder } from "../../../ontology/work-order"
import {
  deadlineLabel,
  formatDate,
  formatDateTime,
  formatMoney,
  humanize,
  QueryState,
  StatusBadge,
  StatusIndicator,
} from "../../_components/ui"
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
type DetailTab = "overview" | "activity" | "evidence"

export default function ServiceCaseDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const [tab, setTab] = useState<DetailTab>("overview")
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
    .sort(
      (left, right) =>
        timestamp(right.properties.recordedAt) - timestamp(left.properties.recordedAt)
    )[0]

  let taskAction: ReactNode = null
  if (serviceCase?.properties.status === "new") {
    taskAction = (
      <Button
        disabled={acknowledge.isPending}
        onClick={() => acknowledge.mutate({ operatorName: "Alex Dawson" })}
      >
        {acknowledge.isPending ? "Acknowledging…" : "Acknowledge case"}
      </Button>
    )
  } else if (
    serviceCase?.properties.status === "in_service" &&
    completedVisit &&
    serviceCase.links.equipment
  ) {
    taskAction = (
      <Button
        disabled={verify.isPending}
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
      </Button>
    )
  } else if (serviceCase?.properties.status === "resolved") {
    taskAction = (
      <Button
        disabled={close.isPending}
        onClick={() => close.mutate({ summary: serviceCase.properties.resolutionSummary })}
      >
        {close.isPending ? "Closing…" : "Close service case"}
      </Button>
    )
  } else if (serviceCase?.properties.status === "triage") {
    taskAction = (
      <Button asChild>
        <Link to="/dispatch">Review dispatch</Link>
      </Button>
    )
  } else if (serviceCase?.properties.status === "awaiting_authorization") {
    taskAction = (
      <Button asChild>
        <Link to="/quotes">Review authorization</Link>
      </Button>
    )
  } else if (workspaceHref) {
    taskAction = (
      <Button asChild>
        <Link to={workspaceHref}>Review field diagnosis</Link>
      </Button>
    )
  }

  return (
    <QueryState
      loading={serviceCaseResult.isLoading}
      error={serviceCaseResult.isError}
      empty={!serviceCase}
      emptyMessage="Service case not found."
    >
      {serviceCase ? (
        <div className="pb-8">
          <Link
            to="/service-cases"
            className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" strokeWidth={1.8} /> Service cases
          </Link>

          <header className="mb-5 flex items-start justify-between gap-6 max-md:flex-col">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm font-semibold text-foreground">
                  {serviceCase.properties.number}
                </span>
                <StatusIndicator value={serviceCase.properties.severity} />
                <StatusIndicator value={serviceCase.properties.status} />
              </div>
              <h1 className="mt-3 max-w-4xl text-[32px] leading-9 font-semibold tracking-[-0.035em]">
                {caseHeadline(
                  serviceCase.properties.title,
                  serviceCase.links.equipment?.properties.name
                )}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                {caseImpact(serviceCase)}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {serviceCase.links.customer?.properties.name} ·{" "}
                {serviceCase.links.facility?.properties.name} ·{" "}
                {serviceCase.links.equipment?.properties.name}
              </p>
            </div>
            {workspaceHref ? (
              <Button asChild variant="outline" className="h-11 shrink-0 gap-2 bg-card">
                <Link to={workspaceHref}>
                  <ExternalLink className="size-4" /> Open field workspace
                </Link>
              </Button>
            ) : null}
          </header>

          <CaseSummary
            serviceCase={serviceCase}
            workOrders={workOrders}
            visits={visits}
            quotes={quotes}
            latestDiagnosis={latestDiagnosis}
          />

          <DetailTabs value={tab} onChange={setTab} />

          {tab === "overview" ? (
            <Overview
              serviceCase={serviceCase}
              workOrders={workOrders}
              visits={visits}
              notes={notes}
              quotes={quotes}
              latestDiagnosis={latestDiagnosis}
              assignedWorkOrder={assignedWorkOrder}
              assignedTechnician={assignedTechnician}
              currentVisit={currentVisit}
              workspaceHref={workspaceHref}
              taskAction={taskAction}
            />
          ) : null}

          {tab === "activity" ? (
            <ContentCard title="Response activity">
              <Timeline
                serviceCase={serviceCase}
                workOrders={workOrders}
                visits={visits}
                notes={notes}
                quotes={quotes}
              />
            </ContentCard>
          ) : null}

          {tab === "evidence" ? (
            <OperationalEvidence
              serviceCase={serviceCase}
              workOrders={workOrders}
              visits={visits}
              notes={notes}
              quotes={quotes}
            />
          ) : null}
        </div>
      ) : null}
    </QueryState>
  )
}

function CaseSummary({
  serviceCase,
  workOrders,
  visits,
  quotes,
  latestDiagnosis,
}: {
  serviceCase: ServiceCaseRow
  workOrders: readonly WorkOrderRow[]
  visits: readonly VisitRow[]
  quotes: readonly QuoteRow[]
  latestDiagnosis: NoteRow | undefined
}) {
  const equipment = serviceCase.links.equipment?.properties
  const illustration = equipmentIllustration(equipment?.name, equipment?.equipmentType)

  return (
    <section className="relative overflow-hidden rounded-xl border border-border/85 bg-card px-5 py-5 sm:px-6 sm:py-6">
      <div className={illustration ? "min-w-0 xl:pr-[300px]" : "min-w-0"}>
        <h2 className="text-base font-semibold tracking-[-0.015em]">Current situation</h2>
        <p className="mt-1.5 text-sm leading-6 text-foreground">
          {situationSummary(serviceCase, latestDiagnosis)}
        </p>

        <div className="mt-4 grid gap-3 border-t border-border/75 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryFact icon={Clock3} label="SLA">
            <StatusIndicator value={serviceCase.properties.slaStatus} />
          </SummaryFact>
          <SummaryFact icon={Timer} label="Response">
            {deadlineLabel(serviceCase.properties.responseDeadline)}
          </SummaryFact>
          <SummaryFact icon={ShieldCheck} label="Coverage">
            <StatusIndicator value={serviceCase.properties.coverageStatus} />
          </SummaryFact>
          <SummaryFact icon={UserRound} label="Owner">
            {serviceCase.properties.ownerName ?? "Unassigned"}
          </SummaryFact>
        </div>

        <LifecycleRail
          serviceCase={serviceCase}
          workOrders={workOrders}
          visits={visits}
          quotes={quotes}
        />
      </div>

      {illustration ? (
        <img
          src={illustration}
          alt={`Isometric illustration of ${equipment?.name ?? "case equipment"}`}
          className="mx-auto mt-5 h-64 w-full max-w-[300px] object-contain xl:absolute xl:top-2 xl:right-5 xl:mt-0 xl:h-[290px] xl:w-[270px]"
        />
      ) : null}
    </section>
  )
}

function SummaryFact({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-3 border-border/75 sm:border-r sm:pr-3 sm:even:border-r-0 lg:even:border-r lg:last:border-r-0">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" strokeWidth={1.7} />
      <dl className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-1 text-xs font-semibold text-foreground">{children}</dd>
      </dl>
    </div>
  )
}

function LifecycleRail({
  serviceCase,
  workOrders,
  visits,
  quotes,
}: {
  serviceCase: ServiceCaseRow
  workOrders: readonly WorkOrderRow[]
  visits: readonly VisitRow[]
  quotes: readonly QuoteRow[]
}) {
  const hasDiagnosis = visits.some((visit) => Boolean(visit.properties.diagnosisDisposition))
  const authorizationComplete =
    quotes.length === 0
      ? hasDiagnosis &&
        visits.every((visit) => visit.properties.diagnosisDisposition !== "quote_required")
      : quotes.some((quote) => ["approved", "declined"].includes(quote.properties.status))
  const stages = [
    {
      label: "Alarm",
      detail: `${serviceCase.links.originatingAlarms.length} signal`,
      complete: true,
    },
    {
      label: "Coverage",
      detail: humanize(serviceCase.properties.coverageStatus),
      complete: Boolean(serviceCase.links.appliedContract),
    },
    {
      label: "Dispatch",
      detail: workOrders[0]?.properties.number ?? "Not dispatched",
      complete: workOrders.length > 0,
    },
    {
      label: "Diagnosis",
      detail: hasDiagnosis ? "Finding recorded" : "In progress",
      complete: hasDiagnosis,
    },
    {
      label: "Authorization",
      detail: quotes[0] ? humanize(quotes[0].properties.status) : "Not required",
      complete: authorizationComplete,
    },
    {
      label: "Repair",
      detail: visits.some((visit) => visit.properties.status === "completed")
        ? "Field work complete"
        : "Pending",
      complete: visits.some((visit) => visit.properties.status === "completed"),
    },
    {
      label: "Recovery",
      detail: ["resolved", "closed"].includes(serviceCase.properties.status)
        ? "Verified"
        : "Pending",
      complete: ["resolved", "closed"].includes(serviceCase.properties.status),
    },
  ]
  const incompleteIndex = stages.findIndex((stage) => !stage.complete)
  const currentIndex = incompleteIndex === -1 ? stages.length - 1 : incompleteIndex

  return (
    <div className="mt-5 overflow-x-auto pb-1">
      <ol className="grid min-w-[700px] grid-cols-7" aria-label="Service response progress">
        {stages.map((stage, index) => {
          const current = index === currentIndex
          return (
            <li key={stage.label} className="relative text-left">
              {index < stages.length - 1 ? (
                <span
                  className={`absolute top-3.5 left-4 h-px w-[calc(100%-1rem)] ${
                    stage.complete ? "bg-primary" : "bg-border"
                  }`}
                  aria-hidden="true"
                />
              ) : null}
              <span
                className={`relative z-10 grid size-7 place-items-center rounded-full border bg-card ${
                  stage.complete
                    ? "border-primary bg-primary text-primary-foreground"
                    : current
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground"
                }`}
              >
                {stage.complete ? <Check className="size-3.5" /> : <Circle className="size-3" />}
              </span>
              <strong className="mt-2 block text-xs font-semibold">{stage.label}</strong>
              <span className="mt-0.5 block truncate pr-2 text-[10px] text-muted-foreground">
                {stage.detail}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function DetailTabs({
  value,
  onChange,
}: {
  value: DetailTab
  onChange: (value: DetailTab) => void
}) {
  const tabs: readonly [DetailTab, string][] = [
    ["overview", "Overview"],
    ["activity", "Activity"],
    ["evidence", "Evidence"],
  ]

  return (
    <div className="mt-2 mb-4 flex border-b border-border/80" role="tablist">
      {tabs.map(([tab, label]) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={value === tab}
          className={
            value === tab
              ? "h-11 border-b-2 border-primary px-3 text-sm font-semibold text-primary"
              : "h-11 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          }
          onClick={() => onChange(tab)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function Overview({
  serviceCase,
  workOrders,
  visits,
  notes,
  quotes,
  latestDiagnosis,
  assignedWorkOrder,
  assignedTechnician,
  currentVisit,
  workspaceHref,
  taskAction,
}: {
  serviceCase: ServiceCaseRow
  workOrders: readonly WorkOrderRow[]
  visits: readonly VisitRow[]
  notes: readonly NoteRow[]
  quotes: readonly QuoteRow[]
  latestDiagnosis: NoteRow | undefined
  assignedWorkOrder: WorkOrderRow | undefined
  assignedTechnician: WorkOrderRow["links"]["assignee"] | undefined
  currentVisit: VisitRow | undefined
  workspaceHref: string | undefined
  taskAction: ReactNode
}) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.9fr)]">
      <div className="grid gap-3">
        <LatestDiagnosis
          serviceCase={serviceCase}
          diagnosis={latestDiagnosis}
          workOrder={assignedWorkOrder ?? workOrders[0]}
          visit={currentVisit}
          workspaceHref={workspaceHref}
          taskAction={taskAction}
        />

        <ContentCard title="Response activity">
          <Timeline
            serviceCase={serviceCase}
            workOrders={workOrders}
            visits={visits}
            notes={notes}
            quotes={quotes}
            limit={3}
            compact
          />
        </ContentCard>
      </div>

      <aside className="grid gap-3 lg:sticky lg:top-4">
        <ContentCard title="Case essentials">
          <dl className="grid gap-4 px-5 py-4 text-sm">
            <Detail label="Facility">{serviceCase.links.facility?.properties.name ?? "—"}</Detail>
            <Detail label="Access">
              {serviceCase.links.facility?.properties.accessNotes ?? "No special access notes."}
            </Detail>
            <Detail label="Equipment">
              <Link
                className="font-medium text-primary hover:underline"
                to={`/equipment/${encodeURIComponent(serviceCase.links.equipment?.primaryId ?? "")}`}
              >
                {serviceCase.links.equipment?.properties.name ?? "—"}
              </Link>
            </Detail>
            <Detail label="Contract">
              {serviceCase.links.appliedContract?.properties.name ?? "No contract applied"}
            </Detail>
            <Detail label="Resolution target">
              {formatDateTime(serviceCase.properties.resolutionDeadline)}
            </Detail>
          </dl>
        </ContentCard>

        <ContentCard title="Response team">
          <dl className="grid gap-4 px-5 py-4 text-sm">
            <Detail label="Case owner">{serviceCase.properties.ownerName ?? "Unassigned"}</Detail>
            <Detail label="Assigned technician">
              {assignedTechnician?.properties.name ?? "Not yet assigned"}
              {assignedTechnician?.properties.phone ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {assignedTechnician.properties.phone}
                </span>
              ) : null}
            </Detail>
            <Detail label="Work order">
              {assignedWorkOrder?.properties.number ?? "Not dispatched"}
            </Detail>
          </dl>
        </ContentCard>
      </aside>
    </div>
  )
}

function LatestDiagnosis({
  serviceCase,
  diagnosis,
  workOrder,
  visit,
  workspaceHref,
  taskAction,
}: {
  serviceCase: ServiceCaseRow
  diagnosis: NoteRow | undefined
  workOrder: WorkOrderRow | undefined
  visit: VisitRow | undefined
  workspaceHref: string | undefined
  taskAction: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/85 bg-card">
      <div className="px-5 py-4 sm:px-6 sm:py-5">
        <h2 className="text-base font-semibold tracking-[-0.015em]">Latest field diagnosis</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatDateTime(diagnosis?.properties.recordedAt)}
          {diagnosis?.links.author?.properties.name ? (
            <> · {diagnosis.links.author.properties.name}</>
          ) : serviceCase.properties.ownerName ? (
            <> · {serviceCase.properties.ownerName}</>
          ) : null}
        </p>

        <p className="mt-3 max-w-3xl text-lg leading-7 font-medium tracking-[-0.015em] text-foreground">
          {diagnosis?.properties.body ?? "The field diagnosis has not been recorded yet."}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <ClipboardCheck className="size-4" strokeWidth={1.7} />
            {workOrder?.properties.number ?? "No work order"}
          </span>
          <span className="inline-flex items-center gap-2">
            <Wrench className="size-4" strokeWidth={1.7} />
            {visit?.properties.number ?? "No visit"}
          </span>
          <span className="inline-flex items-center gap-2">
            <Radio className="size-4" strokeWidth={1.7} />
            {visit
              ? `${humanize(visit.properties.status)} visit`
              : humanize(serviceCase.properties.status)}
          </span>
        </div>
      </div>

      {taskAction || workspaceHref ? (
        <div className="flex flex-wrap items-center gap-4 border-t border-border/75 bg-muted/25 px-5 py-3 sm:px-6">
          {taskAction}
          {workspaceHref ? (
            <Link
              to={workspaceHref}
              className="text-sm font-semibold text-primary transition-colors hover:text-foreground"
            >
              Open technician workspace
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function ContentCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/85 bg-card">
      <header className="border-b border-border/75 px-5 py-3.5">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
      </header>
      {children}
    </section>
  )
}

function OperationalEvidence({
  serviceCase,
  workOrders,
  visits,
  notes,
  quotes,
}: {
  serviceCase: ServiceCaseRow
  workOrders: readonly WorkOrderRow[]
  visits: readonly VisitRow[]
  notes: readonly NoteRow[]
  quotes: readonly QuoteRow[]
}) {
  const alarm = serviceCase.links.originatingAlarms[0]
  const contract = serviceCase.links.appliedContract
  const workOrder = workOrders[0]
  const visit = visits[0]
  const diagnosis = notes.find((note) => note.properties.noteType === "diagnostic")
  const quote = quotes[0]
  return (
    <section className="overflow-hidden rounded-xl border border-border/85 bg-card">
      <header className="border-b border-border/80 px-5 py-4">
        <h2 className="text-base font-semibold">Connected operational evidence</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Source records that explain the current case state.
        </p>
      </header>
      <div className="grid md:grid-cols-2">
        <EvidenceBlock icon={Radio} title="Alarm and coverage">
          <EvidenceLine label="Signal" value={alarm?.properties.message ?? "No alarm attached"} />
          <EvidenceLine
            label="Observed"
            value={formatDateTime(
              alarm?.properties.observedAt ?? serviceCase.properties.detectedAt
            )}
          />
          <EvidenceLine label="Contract" value={contract?.properties.name ?? "No contract"} />
          <EvidenceLine
            label="Terms"
            value={
              contract
                ? `${contract.properties.responseTargetMinutes}m response · ${
                    contract.properties.includedLabor ? "labor included" : "labor excluded"
                  }${contract.properties.majorComponentsExcluded ? " · major parts excluded" : ""}`
                : "Coverage not established"
            }
          />
        </EvidenceBlock>
        <EvidenceBlock icon={Truck} title="Dispatch and field response">
          <EvidenceLine
            label="Work order"
            value={
              workOrder
                ? `${workOrder.properties.number} · ${workOrder.properties.scope}`
                : "Pending"
            }
          />
          <EvidenceLine
            label="Technician"
            value={workOrder?.links.assignee?.properties.name ?? "Not assigned"}
          />
          <EvidenceLine
            label="Visit"
            value={
              visit
                ? `${visit.properties.number} · ${humanize(visit.properties.status)}`
                : "Not scheduled"
            }
          />
          <EvidenceLine
            label="Window"
            value={formatDateTime(workOrder?.properties.scheduledStart)}
          />
        </EvidenceBlock>
        <EvidenceBlock icon={ClipboardCheck} title="Diagnosis and repair">
          <EvidenceLine
            label="Finding"
            value={diagnosis?.properties.body ?? "No diagnosis recorded"}
          />
          <EvidenceLine
            label="Disposition"
            value={humanize(visit?.properties.diagnosisDisposition ?? "Pending")}
          />
          <EvidenceLine
            label="Work performed"
            value={visit?.properties.workPerformed ?? "Pending"}
          />
          <EvidenceLine
            label="Service report"
            value={visit?.properties.serviceReport?.fileName ?? "Not generated"}
          />
        </EvidenceBlock>
        <EvidenceBlock icon={ShieldCheck} title="Authorization and recovery">
          <EvidenceLine
            label="Quote"
            value={
              quote
                ? `${quote.properties.number} · ${formatMoney(quote.properties.amount)}`
                : "Not required"
            }
          />
          <EvidenceLine
            label="Decision"
            value={
              quote
                ? `${humanize(quote.properties.status)} · valid ${formatDate(quote.properties.validUntil)}`
                : "—"
            }
          />
          <EvidenceLine
            label="Equipment"
            value={humanize(serviceCase.links.equipment?.properties.health ?? "Unknown")}
          />
          <EvidenceLine
            label="Outcome"
            value={serviceCase.properties.resolutionSummary ?? "Recovery not yet verified"}
          />
        </EvidenceBlock>
      </div>
    </section>
  )
}

function EvidenceBlock({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: ReactNode
}) {
  return (
    <div className="border-b border-border/75 p-5 md:even:border-l md:[&:nth-last-child(-n+2)]:border-b-0">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-primary" />
        <h3 className="text-xs font-semibold">{title}</h3>
      </div>
      <dl className="grid gap-2.5">{children}</dl>
    </div>
  )
}

function EvidenceLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 text-xs leading-5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{value}</dd>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-1.5 leading-5 text-foreground">{children}</dd>
    </div>
  )
}

interface TimelineEvent {
  id: string
  at: string | Date | undefined
  icon: LucideIcon
  title: string
  detail?: string
  status?: string
}

function Timeline({
  serviceCase,
  workOrders,
  visits,
  notes,
  quotes,
  limit,
  compact = false,
}: {
  serviceCase: ServiceCaseRow
  workOrders: readonly WorkOrderRow[]
  visits: readonly VisitRow[]
  notes: readonly NoteRow[]
  quotes: readonly QuoteRow[]
  limit?: number
  compact?: boolean
}) {
  const events: TimelineEvent[] = [
    ...serviceCase.links.originatingAlarms.map((alarm) => ({
      id: `${alarm.primaryId}-observed`,
      at: alarm.properties.observedAt,
      icon: Radio,
      title: "Building controls raised an alarm",
      detail: alarm.properties.message,
      status: alarm.properties.severity,
    })),
    ...workOrders.map((workOrder) => ({
      id: `${workOrder.primaryId}-dispatch`,
      at: workOrder.properties.dispatchedAt ?? workOrder.properties.scheduledStart,
      icon: Truck,
      title: `${workOrder.properties.number} dispatched`,
      detail: `${workOrder.links.assignee?.properties.name ?? "Unassigned"} · ${workOrder.properties.scope}`,
      status: workOrder.properties.status,
    })),
    ...visits.flatMap((visit) => [
      {
        id: `${visit.primaryId}-start`,
        at: visit.properties.startedAt ?? visit.properties.scheduledStart,
        icon: Wrench,
        title: `${visit.properties.number} ${visit.properties.startedAt ? "started" : "scheduled"}`,
        detail: visit.links.technician?.properties.name,
        status: visit.properties.status,
      },
      ...(visit.properties.completedAt
        ? [
            {
              id: `${visit.primaryId}-complete`,
              at: visit.properties.completedAt,
              icon: ClipboardCheck,
              title: `${visit.properties.number} completed`,
              detail: visit.properties.workPerformed,
              status: visit.properties.completionDisposition,
            },
          ]
        : []),
    ]),
    ...notes.map((note) => ({
      id: note.primaryId,
      at: note.properties.recordedAt,
      icon: FileText,
      title: `${humanize(note.properties.noteType)} note added`,
      detail: note.properties.body,
    })),
    ...quotes.map((quote) => ({
      id: quote.primaryId,
      at: quote.properties.decisionAt ?? quote.properties.sourceUpdatedAt,
      icon: ShieldCheck,
      title: `${quote.properties.number} · ${formatMoney(quote.properties.amount)}`,
      detail: quote.properties.scope,
      status: quote.properties.status,
    })),
    {
      id: `${serviceCase.primaryId}-created`,
      at: serviceCase.properties.detectedAt,
      icon: Radio,
      title: `${serviceCase.properties.number} opened`,
      detail: serviceCase.properties.customerImpact,
      status: serviceCase.properties.severity,
    },
    ...(serviceCase.properties.acknowledgedAt
      ? [
          {
            id: `${serviceCase.primaryId}-acknowledged`,
            at: serviceCase.properties.acknowledgedAt,
            icon: Check,
            title: "Case acknowledged",
            detail: serviceCase.properties.ownerName,
          },
        ]
      : []),
    ...(serviceCase.properties.resolvedAt
      ? [
          {
            id: `${serviceCase.primaryId}-resolved`,
            at: serviceCase.properties.resolvedAt,
            icon: Check,
            title: "Equipment recovery verified",
            detail: serviceCase.properties.resolutionSummary,
            status: "resolved",
          },
        ]
      : []),
  ].sort((left, right) => timestamp(right.at) - timestamp(left.at))
  const visibleEvents = limit ? events.slice(0, limit) : events

  return (
    <ol className="relative px-5 before:absolute before:top-5 before:bottom-5 before:left-[32px] before:w-px before:bg-border">
      {visibleEvents.map((event) => (
        <li
          key={event.id}
          className="relative grid min-h-12 gap-2 py-3 pl-11 sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <span className="absolute top-3.5 left-0 z-10 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground">
            <event.icon className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{event.title}</p>
            {!compact && event.detail ? (
              <p className="mt-1 text-sm leading-5 text-muted-foreground">{event.detail}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 sm:block sm:text-right">
            <time className="block text-[11px] text-muted-foreground">
              {formatDateTime(event.at)}
            </time>
            {!compact && event.status ? <StatusBadge value={event.status} /> : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

function caseHeadline(title: string, equipmentName: string | undefined): string {
  const escapedName = equipmentName?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const withoutEquipment = escapedName
    ? title.replace(new RegExp(`^${escapedName}\\s+(?:entered\\s+)?`, "i"), "")
    : title
  const normalized = withoutEquipment.replaceAll("-", " ").replace(/\.$/, "")
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function caseImpact(serviceCase: ServiceCaseRow): string {
  if (serviceCase.properties.number === "SC-1038") {
    return "Boiler 2 is unavailable. Heating capacity is reduced for the outpatient wing."
  }
  return serviceCase.properties.customerImpact
}

function situationSummary(serviceCase: ServiceCaseRow, diagnosis: NoteRow | undefined): string {
  if (serviceCase.properties.number === "SC-1038") {
    return "Technician is diagnosing an intermittent proving-circuit fault."
  }
  if (diagnosis) return "The technician has recorded a field diagnosis for review."
  return serviceCase.properties.nextAction ?? "Review the case and determine the next action."
}

function equipmentIllustration(
  equipmentName: string | undefined,
  equipmentType: string | undefined
): string | undefined {
  const normalized = equipmentName?.toLowerCase() ?? ""
  if (normalized === "rtu-2") return "/illustrations/rtu-2.webp"
  if (normalized === "rtu-7") return "/illustrations/rtu-7.webp"
  if (normalized === "ahu-3") return "/illustrations/ahu-3.webp"
  if (normalized.includes("controller")) return "/illustrations/building-controller.webp"
  if (equipmentType === "boiler") return "/illustrations/boiler-2.webp"
  return undefined
}

function timestamp(value: string | Date | undefined): number {
  if (!value) return 0
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}
