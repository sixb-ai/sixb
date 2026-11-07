import { useActionRunMutation, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, ClipboardCheck, FileText, Mail, Wrench } from "lucide-react"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { FieldNote } from "../../../ontology/field-note"
import { ServiceCase } from "../../../ontology/service-case"
import { ServiceVisit } from "../../../ontology/service-visit"
import { Technician } from "../../../ontology/technician"
import { WorkOrder } from "../../../ontology/work-order"
import { EquipmentPicture } from "../../_components/equipment-picture"
import { ErrorLine, NextStepCard, pillClass } from "../../_components/next-step"
import { StageRail } from "../../_components/stage-rail"
import { Timeline, type TimelineEntry } from "../../_components/timeline"
import {
  CaseClockText,
  Fact,
  formatDateTime,
  humanize,
  initials,
  QueryState,
  Section,
  StatusBadge,
  StatusIndicator,
} from "../../_components/ui"
import type { QueryRow } from "../../_lib/query-types"
import { caseClock } from "../../_lib/service-cases"
import { currentWork } from "../../_lib/technicians"

const techniciansQuery = objects(Technician).query()

function technicianQuery(id: string) {
  return techniciansQuery.where((technician) => technician.p.id.eq(id))
}

/** One technician's visits, newest first, with the case and unit each one serves. */
function visitsQuery(technicianId: string) {
  return technicianQuery(technicianId)
    .traverse(ServiceVisit.l.technician, { direction: "incoming" })
    .expand(ServiceVisit.l.workOrder, (workOrder) =>
      workOrder
        .expand(WorkOrder.l.serviceCase, (serviceCase) =>
          serviceCase.expand(ServiceCase.l.customer).expand(ServiceCase.l.facility)
        )
        .expand(WorkOrder.l.equipment)
    )
    .orderBy(ServiceVisit.p.scheduledStart, "desc")
    .limit(100)
}

/** The notes one technician wrote, newest first. */
function notesQuery(technicianId: string) {
  return technicianQuery(technicianId)
    .traverse(FieldNote.l.author, { direction: "incoming" })
    .expand(FieldNote.l.visit)
    .orderBy(FieldNote.p.recordedAt, "desc")
    .limit(100)
}

type VisitRow = QueryRow<ReturnType<typeof visitsQuery>>
type NoteRow = QueryRow<ReturnType<typeof notesQuery>>
type TechnicianRow = QueryRow<typeof techniciansQuery>
type VisitWorkOrder = NonNullable<VisitRow["links"]["workOrder"]>
type VisitServiceCase = NonNullable<VisitWorkOrder["links"]["serviceCase"]>
type VisitEquipment = NonNullable<VisitWorkOrder["links"]["equipment"]>
type Disposition = "resolved_on_site" | "follow_up_required" | "quote_required"

const dispositions: ReadonlyArray<readonly [Disposition, string]> = [
  ["resolved_on_site", "Resolved on site"],
  ["follow_up_required", "Follow-up required"],
  ["quote_required", "Quote required"],
]

const visitUnderWay = new Set(["in_progress"])

const visitStages = [
  { id: "scheduled", label: "Scheduled" },
  { id: "on_site", label: "On site" },
  { id: "diagnosis", label: "Diagnosis" },
  { id: "complete", label: "Complete" },
]

export default function TechnicianWorkspacePage() {
  const { id = "" } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const requestedVisit = searchParams.get("visit")
  const technicianResult = useObjectsQuery(useMemo(() => technicianQuery(id), [id]))
  const visitsResult = useObjectsQuery(useMemo(() => visitsQuery(id), [id]))
  const notesResult = useObjectsQuery(useMemo(() => notesQuery(id), [id]))
  const technician = technicianResult.data?.objects[0]
  const technicianVisits = visitsResult.data?.objects ?? []
  const activeVisit = currentWork(
    technicianVisits.filter(
      (visit) =>
        visit.properties.status === "scheduled" || visit.properties.status === "in_progress"
    ),
    visitUnderWay
  )
  const visit = requestedVisit
    ? technicianVisits.find((item) => item.primaryId === requestedVisit)
    : activeVisit
  const workOrder = visit?.links.workOrder
  const serviceCase = workOrder?.links.serviceCase
  const equipment = workOrder?.links.equipment
  const technicianNotes = notesResult.data?.objects ?? []
  const visitNotes = visit
    ? technicianNotes.filter((note) => note.links.visit?.primaryId === visit.primaryId)
    : []

  return (
    <QueryState
      loading={technicianResult.isLoading || visitsResult.isLoading || notesResult.isLoading}
      error={technicianResult.isError || visitsResult.isError || notesResult.isError}
      empty={!technician}
      emptyMessage="Technician not found."
    >
      {technician ? (
        <div className="flex flex-col gap-6">
          <TechnicianHeader technician={technician} visits={technicianVisits} />

          {visit && workOrder && serviceCase && equipment ? (
            <VisitWorkspace
              technician={technician}
              visit={visit}
              visits={technicianVisits}
              workOrder={workOrder}
              serviceCase={serviceCase}
              equipment={equipment}
              notes={visitNotes}
            />
          ) : (
            <TechnicianProfile
              technician={technician}
              visits={technicianVisits}
              notes={technicianNotes}
            />
          )}
        </div>
      ) : null}
    </QueryState>
  )
}

function TechnicianHeader({
  technician,
  visits,
}: {
  technician: TechnicianRow
  visits: readonly VisitRow[]
}) {
  const completed = visits.filter((visit) => visit.properties.status === "completed").length
  return (
    <header className="flex flex-col gap-4">
      <nav className="flex items-center gap-2 text-[14px] text-muted-foreground">
        <Link to="/technicians" className="text-primary hover:underline">
          Technicians
        </Link>
        <ChevronRight className="size-3.5" aria-hidden="true" />
        <span className="truncate">{technician.properties.name}</span>
      </nav>

      <div className="flex items-start justify-between gap-6 max-md:flex-col max-md:gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-[var(--northline-tint)] text-[20px] font-semibold tracking-[-0.02em] text-primary sm:size-16 sm:text-[22px]"
            aria-hidden="true"
          >
            {initials(technician.properties.name)}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[40px]">
              {technician.properties.name}
            </h1>
            <p className="text-[16px] text-muted-foreground">
              {humanize(technician.properties.territory)} ·{" "}
              {humanize(technician.properties.certification)} certified
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5 md:pt-2">
          <StatusBadge value={technician.properties.availability} />
          <a
            href={`mailto:${technician.properties.email}`}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-black/[0.05] px-5 text-[14px] font-semibold transition-colors hover:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:bg-white/[0.08]"
          >
            <Mail className="size-4" strokeWidth={1.8} aria-hidden="true" /> Email
          </a>
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-9 gap-y-3 pt-1">
        <Fact label="Phone">{technician.properties.phone ?? "Not on file"}</Fact>
        <Fact label="Email">
          <span className="break-all">{technician.properties.email}</span>
        </Fact>
        <Fact label="Completed visits">{completed}</Fact>
      </dl>
    </header>
  )
}

function TechnicianProfile({
  technician,
  visits,
  notes,
}: {
  technician: TechnicianRow
  visits: readonly VisitRow[]
  notes: readonly NoteRow[]
}) {
  const available = technician.properties.availability === "available"
  return (
    <>
      {available ? (
        <NextStepCard
          title="Ready for dispatch"
          detail="No visit is assigned. Match this technician to waiting work on the dispatch board."
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <Link to="/dispatch" className={pillClass("primary", "max-sm:h-11 max-sm:w-full")}>
              Open dispatch board
            </Link>
          </div>
        </NextStepCard>
      ) : (
        <Section>
          <div className="flex flex-col gap-1.5 px-6 py-5">
            <StatusIndicator value={technician.properties.availability} />
            <h2 className="text-[19px] leading-6 font-semibold tracking-[-0.015em]">
              No active field visit
            </h2>
            <p className="text-[14px] text-muted-foreground">
              {technician.properties.availability === "assigned"
                ? "Assigned work appears here once a visit is scheduled."
                : "Not on shift right now."}
            </p>
          </div>
        </Section>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <Section
          title="Visits"
          description={
            visits.length === 1 ? "1 visit, newest first" : `${visits.length} visits, newest first`
          }
          className="min-w-0 flex-[999_1_560px]"
        >
          <VisitList technician={technician} visits={visits} />
        </Section>

        <Section title="Field notes" className="min-w-0 flex-[1_1_320px]">
          <Timeline entries={activityEntries([], notes)} limit={6} />
        </Section>
      </div>
    </>
  )
}

function VisitWorkspace({
  technician,
  visit,
  visits,
  workOrder,
  serviceCase,
  equipment,
  notes,
}: {
  technician: TechnicianRow
  visit: VisitRow
  visits: readonly VisitRow[]
  workOrder: VisitWorkOrder
  serviceCase: VisitServiceCase
  equipment: VisitEquipment
  notes: readonly NoteRow[]
}) {
  return (
    <>
      <VisitHero
        visit={visit}
        workOrder={workOrder}
        serviceCase={serviceCase}
        equipment={equipment}
      />

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          {/* Keyed by visit: what was typed for one visit never carries over to the next. */}
          <VisitAction
            key={visit.primaryId}
            technician={technician}
            visit={visit}
            workOrder={workOrder}
            serviceCase={serviceCase}
            equipment={equipment}
          />

          <Section title="Visit activity" description="Arrival, findings and work, newest first">
            <Timeline entries={activityEntries([visit], notes)} />
          </Section>
        </div>

        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
          <SiteCard
            visit={visit}
            workOrder={workOrder}
            serviceCase={serviceCase}
            equipment={equipment}
          />
          <Section title="Visits">
            <VisitList technician={technician} visits={visits} currentId={visit.primaryId} />
          </Section>
        </aside>
      </div>
    </>
  )
}

function VisitHero({
  visit,
  workOrder,
  serviceCase,
  equipment,
}: {
  visit: VisitRow
  workOrder: VisitWorkOrder
  serviceCase: VisitServiceCase
  equipment: VisitEquipment
}) {
  return (
    <section className="flex flex-wrap overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
      <div className="relative flex min-h-48 flex-[1_1_280px] items-center justify-center bg-muted">
        <EquipmentPicture
          name={equipment.properties.name}
          type={equipment.properties.equipmentType}
          inset="p-5"
          className="absolute inset-0"
          iconClassName="size-14 text-foreground/35"
          alt={`${equipment.properties.name} illustration`}
        />
      </div>

      <div className="flex min-w-0 flex-[999_1_360px] flex-col gap-5 p-5 sm:p-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-muted-foreground tabular-nums">
              {visit.properties.number}
            </span>
            <StatusBadge value={visit.properties.status} />
            <StatusBadge value={serviceCase.properties.severity} />
          </div>
          <h2 className="text-[24px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance sm:text-[28px]">
            {workOrder.properties.title}
          </h2>
          {serviceCase.properties.customerImpact ? (
            <p className="max-w-2xl text-[15px] leading-6 text-pretty text-foreground/75">
              {serviceCase.properties.customerImpact}
            </p>
          ) : null}
          <p className="text-[13.5px] text-muted-foreground">
            {serviceCase.links.customer?.properties.name ?? "Customer"} ·{" "}
            {serviceCase.links.facility?.properties.name ?? "Facility"}
          </p>
        </div>

        <dl className="flex flex-wrap gap-x-9 gap-y-3">
          <Fact label={caseClock(serviceCase.properties).label}>
            <CaseClockText serviceCase={serviceCase.properties} variant="value" />
          </Fact>
          <Fact label="Scheduled">{formatDateTime(visit.properties.scheduledStart)}</Fact>
          <Fact label="Service case">
            <Link
              to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
              className="text-primary hover:underline"
            >
              {serviceCase.properties.number}
            </Link>
          </Fact>
          <Fact label="Equipment">
            <Link
              to={`/equipment/${encodeURIComponent(equipment.primaryId)}`}
              className="text-primary hover:underline"
            >
              {equipment.properties.name}
            </Link>
          </Fact>
        </dl>

        <StageRail stages={visitStages} current={visitStage(visit)} />
      </div>
    </section>
  )
}

function VisitAction({
  technician,
  visit,
  workOrder,
  serviceCase,
  equipment,
}: {
  technician: TechnicianRow
  visit: VisitRow
  workOrder: VisitWorkOrder
  serviceCase: VisitServiceCase
  equipment: VisitEquipment
}) {
  const [finding, setFinding] = useState("")
  const [disposition, setDisposition] = useState<Disposition>("quote_required")
  const [workPerformed, setWorkPerformed] = useState("")
  const subject = { objectType: ServiceVisit, primaryId: visit.primaryId }
  const caseRef = { objectTypeId: "ServiceCase", primaryId: serviceCase.primaryId } as const
  const workOrderRef = { objectTypeId: "WorkOrder", primaryId: workOrder.primaryId } as const
  const equipmentRef = { objectTypeId: "Equipment", primaryId: equipment.primaryId } as const
  const startVisit = useActionRunMutation<{
    serviceCase: typeof caseRef
    workOrder: typeof workOrderRef
  }>({ actionId: "start-service-visit", subject, invalidateOnCommit: true })
  const recordDiagnosis = useActionRunMutation<{
    serviceCase: typeof caseRef
    equipment: typeof equipmentRef
    technician: { objectTypeId: "Technician"; primaryId: string }
    disposition: Disposition
    finding: string
  }>({ actionId: "record-diagnosis", subject, invalidateOnCommit: true })
  const completeVisit = useActionRunMutation<{
    serviceCase: typeof caseRef
    workOrder: typeof workOrderRef
    equipment: typeof equipmentRef
    workPerformed: string
    disposition: "resolved" | "follow_up_required" | "awaiting_parts"
  }>({ actionId: "complete-service-visit", subject, invalidateOnCommit: true })

  if (visit.properties.status === "scheduled") {
    return (
      <NextStepCard
        title="Start the visit"
        detail="Confirm you are on site before recording findings or work performed."
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={startVisit.isPending}
            onClick={() => startVisit.mutate({ serviceCase: caseRef, workOrder: workOrderRef })}
            className={pillClass("primary", "max-sm:h-11 max-sm:w-full")}
          >
            {startVisit.isPending ? "Starting…" : "Start visit"}
          </button>
        </div>
        {startVisit.isError ? (
          <ErrorLine>The visit could not be started. Try again.</ErrorLine>
        ) : null}
      </NextStepCard>
    )
  }

  if (visit.properties.status === "in_progress" && !visit.properties.diagnosisDisposition) {
    return (
      <NextStepCard
        title="Record the diagnosis"
        detail="Describe the confirmed condition and choose what should happen next."
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="diagnosis-finding" className="text-[14px] font-semibold">
              What you found
            </label>
            <textarea
              id="diagnosis-finding"
              value={finding}
              onChange={(event) => setFinding(event.target.value)}
              rows={6}
              placeholder="The observed fault, the tests you ran, and the confirmed cause."
              className={textareaClass}
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[14px] font-semibold">Outcome</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {dispositions.map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 rounded-[12px] px-3.5 py-2.5 text-[14.5px] font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    disposition === value
                      ? "bg-[var(--northline-tint)] text-foreground shadow-[0_0_0_1.5px_var(--primary)]"
                      : "bg-black/[0.035] text-foreground/80 hover:bg-black/[0.06] dark:bg-white/[0.06]"
                  )}
                >
                  <input
                    type="radio"
                    name="diagnosis-disposition"
                    value={value}
                    checked={disposition === value}
                    onChange={() => setDisposition(value)}
                    className="size-4 shrink-0 accent-primary"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/70 pt-5">
            {recordDiagnosis.isError ? (
              <ErrorLine>The diagnosis could not be recorded. Try again.</ErrorLine>
            ) : null}
            <button
              type="button"
              disabled={recordDiagnosis.isPending || !finding.trim()}
              onClick={() =>
                recordDiagnosis.mutate({
                  serviceCase: caseRef,
                  equipment: equipmentRef,
                  technician: { objectTypeId: "Technician", primaryId: technician.primaryId },
                  disposition,
                  finding: finding.trim(),
                })
              }
              className={pillClass("primary", "max-sm:h-11 max-sm:w-full")}
            >
              {recordDiagnosis.isPending ? "Recording…" : "Record diagnosis"}
            </button>
          </div>
        </div>
      </NextStepCard>
    )
  }

  if (visit.properties.status === "in_progress" && visit.properties.diagnosisDisposition) {
    return (
      <NextStepCard
        title="Complete the visit"
        detail="Describe the work you finished so the case can return for recovery verification."
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3 rounded-[14px] bg-muted px-4 py-3">
            <span className="text-[14px] text-foreground/80">Diagnosis recorded</span>
            <StatusBadge value={visit.properties.diagnosisDisposition} />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="work-performed" className="text-[14px] font-semibold">
              Work performed
            </label>
            <textarea
              id="work-performed"
              value={workPerformed}
              onChange={(event) => setWorkPerformed(event.target.value)}
              rows={6}
              placeholder="The work you completed and the final condition of the equipment."
              className={textareaClass}
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/70 pt-5">
            {completeVisit.isError ? (
              <ErrorLine>The visit could not be completed. Try again.</ErrorLine>
            ) : null}
            <button
              type="button"
              disabled={completeVisit.isPending || !workPerformed.trim()}
              onClick={() =>
                completeVisit.mutate({
                  serviceCase: caseRef,
                  workOrder: workOrderRef,
                  equipment: equipmentRef,
                  workPerformed: workPerformed.trim(),
                  disposition: "resolved",
                })
              }
              className={pillClass("primary", "max-sm:h-11 max-sm:w-full")}
            >
              {completeVisit.isPending ? "Completing…" : "Complete visit"}
            </button>
          </div>
        </div>
      </NextStepCard>
    )
  }

  return (
    <Section
      title="Field work completed"
      description="This visit is complete and its service record is preserved."
    >
      <dl className="flex flex-col px-6 pb-4">
        <div className="flex items-center justify-between gap-3 py-2.5">
          <dt className="text-[14.5px] font-medium">Outcome</dt>
          <dd>
            <StatusBadge value={visit.properties.completionDisposition ?? "completed"} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/70 py-2.5">
          <dt className="text-[14.5px] font-medium">Completed</dt>
          <dd className="text-[13.5px] text-muted-foreground tabular-nums">
            {formatDateTime(visit.properties.completedAt)}
          </dd>
        </div>
        <div className="flex flex-col gap-1 border-t border-border/70 py-3">
          <dt className="text-[14.5px] font-medium">Work performed</dt>
          <dd className="text-[15px] leading-6 text-pretty text-foreground/80">
            {visit.properties.workPerformed ?? "No work summary recorded."}
          </dd>
        </div>
      </dl>
    </Section>
  )
}

function SiteCard({
  visit,
  workOrder,
  serviceCase,
  equipment,
}: {
  visit: VisitRow
  workOrder: VisitWorkOrder
  serviceCase: VisitServiceCase
  equipment: VisitEquipment
}) {
  const unit = [equipment.properties.manufacturer, equipment.properties.model]
    .filter(Boolean)
    .join(" ")
  return (
    <Section title="On site">
      <dl className="flex flex-col px-6 pb-3">
        <Detail label="Facility">
          {serviceCase.links.facility?.properties.name ?? "Customer facility"}
        </Detail>
        <Detail label="Site access">
          {serviceCase.links.facility?.properties.accessNotes ?? "Check in with facilities."}
        </Detail>
        <Detail label="Unit">
          {[unit, equipment.properties.serialNumber].filter(Boolean).join(" · ") ||
            equipment.properties.name}
        </Detail>
        <Detail label="Authorized scope">{workOrder.properties.scope}</Detail>
        <Detail label="Visit started">{formatDateTime(visit.properties.startedAt)}</Detail>
      </dl>
    </Section>
  )
}

function VisitList({
  technician,
  visits,
  currentId,
}: {
  technician: TechnicianRow
  visits: readonly VisitRow[]
  currentId?: string
}) {
  if (visits.length === 0) {
    return <p className="px-6 pt-2 pb-6 text-[14px] text-muted-foreground">No visits recorded.</p>
  }
  return (
    <ul className="px-6 pb-3">
      {visits.map((visit) => {
        const workOrder = visit.links.workOrder
        const serviceCase = workOrder?.links.serviceCase
        const current = visit.primaryId === currentId
        const severity = serviceCase?.properties.severity
        return (
          <li key={visit.primaryId} className="border-t border-border/70 first:border-t-0">
            <Link
              to={`/technicians/${encodeURIComponent(technician.primaryId)}?visit=${encodeURIComponent(visit.primaryId)}`}
              aria-current={current ? "page" : undefined}
              className="group flex items-center gap-3 py-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-[13px] font-semibold text-muted-foreground tabular-nums">
                    {visit.properties.number}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[15px] font-semibold group-hover:text-primary",
                      current && "text-primary"
                    )}
                  >
                    {workOrder?.properties.title ?? "Service visit"}
                  </span>
                </span>
                <span className="truncate text-[13px] text-muted-foreground tabular-nums">
                  {current ? "Viewing · " : ""}
                  {formatDateTime(visit.properties.scheduledStart)} ·{" "}
                  {serviceCase?.links.facility?.properties.name ?? "Facility"} ·{" "}
                  {workOrder?.links.equipment?.properties.name ?? "Equipment"}
                </span>
              </span>
              {currentId === undefined && (severity === "critical" || severity === "high") ? (
                <span className="max-sm:hidden">
                  <StatusBadge value={severity} />
                </span>
              ) : null}
              <StatusBadge value={visit.properties.status} />
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

const textareaClass =
  "min-h-36 w-full resize-y rounded-[14px] bg-black/[0.035] px-4 py-3 text-[15px] leading-6 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/[0.06] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border/70 py-3 first:border-t-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-[15px] leading-6 text-pretty">{children}</dd>
    </div>
  )
}

function activityEntries(visits: readonly VisitRow[], notes: readonly NoteRow[]): TimelineEntry[] {
  return [
    ...visits.flatMap((visit): TimelineEntry[] => [
      {
        id: `${visit.primaryId}-start`,
        at: visit.properties.startedAt ?? visit.properties.scheduledStart,
        icon: Wrench,
        title: visit.properties.startedAt ? "Arrived on site" : "Visit scheduled",
        detail: visit.links.workOrder?.links.serviceCase?.links.facility?.properties.name,
        source: visit.properties.number,
      },
      ...(visit.properties.completedAt
        ? [
            {
              id: `${visit.primaryId}-complete`,
              at: visit.properties.completedAt,
              icon: ClipboardCheck,
              title: "Visit completed",
              detail: visit.properties.workPerformed,
              source: visit.properties.number,
              status: visit.properties.completionDisposition,
              emphasis: true,
            },
          ]
        : []),
    ]),
    ...notes.map(
      (note): TimelineEntry => ({
        id: note.primaryId,
        at: note.properties.recordedAt,
        icon: FileText,
        title: `${humanize(note.properties.noteType)} note`,
        detail: note.properties.body,
        source: note.links.visit?.properties.number,
      })
    ),
  ]
}

/** The first stage not yet done; a finished visit rests on "Complete". */
function visitStage(visit: VisitRow): string {
  if (visit.properties.status === "completed" || visit.properties.diagnosisDisposition) {
    return "complete"
  }
  return visit.properties.startedAt ? "diagnosis" : "on_site"
}
