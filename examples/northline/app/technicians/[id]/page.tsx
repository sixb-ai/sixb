import { useActionRunMutation, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Button, NativeSelect, NativeSelectOption, Textarea } from "@sixb/ui/components"
import { ArrowLeft, Check, ChevronRight, Circle, Mail } from "lucide-react"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { FieldNote } from "../../../ontology/field-note"
import { ServiceCase } from "../../../ontology/service-case"
import { ServiceVisit } from "../../../ontology/service-visit"
import { Technician } from "../../../ontology/technician"
import { WorkOrder } from "../../../ontology/work-order"
import {
  deadlineLabel,
  formatDateTime,
  humanize,
  QueryState,
  StatusIndicator,
} from "../../_components/ui"

const visitsQuery = objects(ServiceVisit)
  .query()
  .expand(ServiceVisit.l.technician)
  .expand(ServiceVisit.l.workOrder, (workOrder) =>
    workOrder
      .expand(WorkOrder.l.serviceCase, (serviceCase) =>
        serviceCase.expand(ServiceCase.l.customer).expand(ServiceCase.l.facility)
      )
      .expand(WorkOrder.l.equipment)
  )
  .orderBy(ServiceVisit.p.scheduledStart, "asc")
  .limit(100)

const notesQuery = objects(FieldNote)
  .query()
  .expand(FieldNote.l.visit)
  .expand(FieldNote.l.author)
  .orderBy(FieldNote.p.recordedAt, "desc")
  .limit(100)
const techniciansBaseQuery = objects(Technician).query()

type VisitRow = NonNullable<Awaited<ReturnType<typeof visitsQuery.first>>>
type NoteRow = NonNullable<Awaited<ReturnType<typeof notesQuery.first>>>
type TechnicianRow = NonNullable<Awaited<ReturnType<typeof techniciansBaseQuery.first>>>

export default function TechnicianWorkspacePage() {
  const { id = "" } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const requestedVisit = searchParams.get("visit")
  const technicianQuery = useMemo(
    () => techniciansBaseQuery.where((technician) => technician.p.id.eq(id)),
    [id]
  )
  const technicianResult = useObjectsQuery(technicianQuery)
  const visitsResult = useObjectsQuery(visitsQuery)
  const notesResult = useObjectsQuery(notesQuery)
  const technician = technicianResult.data?.objects[0]
  const technicianVisits = (visitsResult.data?.objects ?? [])
    .filter((visit) => visit.links.technician?.primaryId === id)
    .sort(
      (left, right) =>
        timestamp(right.properties.scheduledStart) - timestamp(left.properties.scheduledStart)
    )
  const activeVisit = technicianVisits.find(
    (visit) => !["completed", "cancelled"].includes(visit.properties.status)
  )
  const visit = requestedVisit
    ? technicianVisits.find((item) => item.primaryId === requestedVisit)
    : activeVisit
  const workOrder = visit?.links.workOrder
  const serviceCase = workOrder?.links.serviceCase
  const equipment = workOrder?.links.equipment
  const technicianNotes = (notesResult.data?.objects ?? []).filter(
    (note) => note.links.author?.primaryId === id
  )
  const visitNotes = visit
    ? technicianNotes.filter((note) => note.links.visit?.primaryId === visit.primaryId)
    : []
  const [finding, setFinding] = useState("")
  const [disposition, setDisposition] = useState<
    "resolved_on_site" | "follow_up_required" | "quote_required"
  >("quote_required")
  const [workPerformed, setWorkPerformed] = useState("")

  const startVisit = useActionRunMutation<{
    serviceCase: { objectTypeId: "ServiceCase"; primaryId: string }
    workOrder: { objectTypeId: "WorkOrder"; primaryId: string }
  }>({
    actionId: "start-service-visit",
    subject: { objectType: ServiceVisit, primaryId: visit?.primaryId ?? "" },
    invalidateOnCommit: true,
  })
  const recordDiagnosis = useActionRunMutation<{
    serviceCase: { objectTypeId: "ServiceCase"; primaryId: string }
    equipment: { objectTypeId: "Equipment"; primaryId: string }
    technician: { objectTypeId: "Technician"; primaryId: string }
    disposition: "resolved_on_site" | "follow_up_required" | "quote_required"
    finding: string
  }>({
    actionId: "record-diagnosis",
    subject: { objectType: ServiceVisit, primaryId: visit?.primaryId ?? "" },
    invalidateOnCommit: true,
  })
  const completeVisit = useActionRunMutation<{
    serviceCase: { objectTypeId: "ServiceCase"; primaryId: string }
    workOrder: { objectTypeId: "WorkOrder"; primaryId: string }
    equipment: { objectTypeId: "Equipment"; primaryId: string }
    workPerformed: string
    disposition: "resolved" | "follow_up_required" | "awaiting_parts"
  }>({
    actionId: "complete-service-visit",
    subject: { objectType: ServiceVisit, primaryId: visit?.primaryId ?? "" },
    invalidateOnCommit: true,
  })

  return (
    <QueryState
      loading={technicianResult.isLoading || visitsResult.isLoading || notesResult.isLoading}
      error={technicianResult.isError || visitsResult.isError || notesResult.isError}
      empty={!technician}
      emptyMessage="Technician not found."
    >
      {technician ? (
        <div className="pb-8">
          <Link
            to="/technicians"
            className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" strokeWidth={1.8} /> Technicians
          </Link>

          <TechnicianMasthead technician={technician} visits={technicianVisits} />

          {visit && workOrder && serviceCase && equipment ? (
            <VisitWorkspace
              visit={visit}
              workOrder={workOrder}
              serviceCase={serviceCase}
              equipment={equipment}
              notes={visitNotes}
              finding={finding}
              disposition={disposition}
              workPerformed={workPerformed}
              setFinding={setFinding}
              setDisposition={setDisposition}
              setWorkPerformed={setWorkPerformed}
              starting={startVisit.isPending}
              recording={recordDiagnosis.isPending}
              completing={completeVisit.isPending}
              onStart={() =>
                startVisit.mutate({
                  serviceCase: {
                    objectTypeId: "ServiceCase",
                    primaryId: serviceCase.primaryId,
                  },
                  workOrder: { objectTypeId: "WorkOrder", primaryId: workOrder.primaryId },
                })
              }
              onRecordDiagnosis={() =>
                recordDiagnosis.mutate({
                  serviceCase: {
                    objectTypeId: "ServiceCase",
                    primaryId: serviceCase.primaryId,
                  },
                  equipment: { objectTypeId: "Equipment", primaryId: equipment.primaryId },
                  technician: { objectTypeId: "Technician", primaryId: technician.primaryId },
                  disposition,
                  finding: finding.trim(),
                })
              }
              onComplete={() =>
                completeVisit.mutate({
                  serviceCase: {
                    objectTypeId: "ServiceCase",
                    primaryId: serviceCase.primaryId,
                  },
                  workOrder: { objectTypeId: "WorkOrder", primaryId: workOrder.primaryId },
                  equipment: { objectTypeId: "Equipment", primaryId: equipment.primaryId },
                  workPerformed: workPerformed.trim(),
                  disposition: "resolved",
                })
              }
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

function TechnicianMasthead({
  technician,
  visits,
}: {
  technician: TechnicianRow
  visits: VisitRow[]
}) {
  const completed = visits.filter((visit) => visit.properties.status === "completed").length
  return (
    <header className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 items-start gap-5 max-sm:flex-col">
        <span className="grid size-[76px] shrink-0 place-items-center rounded-full bg-primary/15 text-2xl font-semibold tracking-[-0.04em] text-primary">
          {initials(technician.properties.name)}
        </span>
        <div className="min-w-0 pt-0.5">
          <StatusIndicator value={technician.properties.availability} />
          <h1 className="mt-3 text-[36px] leading-[1.08] font-semibold tracking-[-0.045em] text-foreground max-sm:text-[32px]">
            {technician.properties.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {humanize(technician.properties.territory)} territory ·{" "}
            {humanize(technician.properties.certification)} certified
          </p>
          <dl className="mt-5 flex flex-wrap items-stretch">
            <MastheadSignal label="Territory">
              {humanize(technician.properties.territory)}
            </MastheadSignal>
            <MastheadSignal label="Qualification">
              {humanize(technician.properties.certification)}
            </MastheadSignal>
            <MastheadSignal label="Completed visits">{completed}</MastheadSignal>
          </dl>
        </div>
      </div>

      <div className="pt-1 lg:justify-self-end">
        <p className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          Field contact
        </p>
        <strong className="mt-2 block text-base font-semibold">
          {technician.properties.phone ?? "No phone available"}
        </strong>
        <span className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <Mail className="size-4 shrink-0" strokeWidth={1.7} />
          {technician.properties.email}
        </span>
        <a
          href={`mailto:${technician.properties.email}`}
          className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-primary bg-card px-5 text-sm font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
        >
          <Mail className="size-4" strokeWidth={1.7} /> Email technician
        </a>
      </div>
    </header>
  )
}

function TechnicianProfile({
  technician,
  visits,
  notes,
}: {
  technician: TechnicianRow
  visits: VisitRow[]
  notes: NoteRow[]
}) {
  const latestNote = notes[0]
  return (
    <>
      <section className="mt-6 overflow-hidden rounded-lg border border-border/90 bg-card">
        <div className="flex items-center justify-between gap-6 px-5 py-5 max-sm:flex-col max-sm:items-start sm:px-6">
          <div>
            <StatusIndicator value={technician.properties.availability} />
            <h2 className="mt-2 text-lg font-semibold tracking-[-0.02em]">
              {technician.properties.availability === "available"
                ? "Ready for dispatch"
                : "No active field visit"}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              {humanize(technician.properties.territory)} coverage ·{" "}
              {humanize(technician.properties.certification)} qualification
            </p>
          </div>
          {technician.properties.availability === "available" ? (
            <Button asChild variant="outline" className="h-10 border-primary text-primary">
              <Link to="/dispatch">Open dispatch board</Link>
            </Button>
          ) : null}
        </div>
      </section>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.9fr)]">
        <section className="overflow-hidden rounded-lg border border-border/90 bg-card">
          <header className="flex items-baseline gap-4 px-5 pt-4 pb-3 sm:px-6">
            <h2 className="text-base font-semibold tracking-[-0.015em]">Recent visits</h2>
            <span className="font-mono text-xs text-muted-foreground">{visits.length}</span>
          </header>
          <div className="mx-5 divide-y divide-border/80 border-t border-border/85 sm:mx-6">
            {visits.map((visit) => {
              const workOrder = visit.links.workOrder
              const serviceCase = workOrder?.links.serviceCase
              return (
                <Link
                  key={visit.primaryId}
                  to={`/technicians/${encodeURIComponent(technician.primaryId)}?visit=${encodeURIComponent(visit.primaryId)}`}
                  className="group grid items-center gap-4 py-4 hover:bg-accent/45 xl:-mx-3 xl:grid-cols-[120px_minmax(0,1fr)_190px_130px_20px] xl:px-3"
                >
                  <span>
                    <strong className="block font-mono text-xs font-semibold">
                      {visit.properties.number}
                    </strong>
                    <StatusIndicator value={visit.properties.status} className="mt-2" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-semibold group-hover:text-primary">
                      {workOrder?.properties.title ?? "Service visit"}
                    </strong>
                    <span className="mt-1.5 block truncate text-xs text-muted-foreground">
                      {serviceCase?.links.facility?.properties.name ?? "Facility"} ·{" "}
                      {workOrder?.links.equipment?.properties.name ?? "Equipment"}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(visit.properties.scheduledStart)}
                  </span>
                  <StatusIndicator value={serviceCase?.properties.severity} />
                  <ChevronRight
                    className="size-5 transition-transform group-hover:translate-x-0.5"
                    strokeWidth={1.7}
                  />
                </Link>
              )
            })}
            {visits.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No service visits recorded.
              </p>
            ) : null}
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-border/90 bg-card">
          <header className="px-5 pt-4 pb-3 sm:px-6">
            <h2 className="text-base font-semibold tracking-[-0.015em]">Latest field record</h2>
          </header>
          <div className="mx-5 border-t border-border/85 py-4 sm:mx-6">
            {latestNote ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <StatusIndicator value={latestNote.properties.noteType} />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {formatDateTime(latestNote.properties.recordedAt)}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-foreground">
                  {latestNote.properties.body}
                </p>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No field notes recorded.
              </p>
            )}
          </div>
        </section>
      </div>
    </>
  )
}

function VisitWorkspace({
  visit,
  workOrder,
  serviceCase,
  equipment,
  notes,
  finding,
  disposition,
  workPerformed,
  setFinding,
  setDisposition,
  setWorkPerformed,
  starting,
  recording,
  completing,
  onStart,
  onRecordDiagnosis,
  onComplete,
}: {
  visit: VisitRow
  workOrder: NonNullable<VisitRow["links"]["workOrder"]>
  serviceCase: NonNullable<NonNullable<VisitRow["links"]["workOrder"]>["links"]["serviceCase"]>
  equipment: NonNullable<NonNullable<VisitRow["links"]["workOrder"]>["links"]["equipment"]>
  notes: NoteRow[]
  finding: string
  disposition: "resolved_on_site" | "follow_up_required" | "quote_required"
  workPerformed: string
  setFinding: (value: string) => void
  setDisposition: (value: "resolved_on_site" | "follow_up_required" | "quote_required") => void
  setWorkPerformed: (value: string) => void
  starting: boolean
  recording: boolean
  completing: boolean
  onStart: () => void
  onRecordDiagnosis: () => void
  onComplete: () => void
}) {
  return (
    <>
      <section className="mt-6 overflow-hidden rounded-lg border border-border/90 bg-card">
        <div className="grid gap-5 px-5 py-5 sm:px-6 xl:grid-cols-[160px_minmax(0,1fr)_220px] xl:items-center">
          <span>
            <strong className="block font-mono text-sm font-semibold text-primary">
              {visit.properties.number}
            </strong>
            <span className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              <StatusIndicator value={visit.properties.status} />
              <StatusIndicator value={serviceCase.properties.severity} />
            </span>
          </span>
          <span className="min-w-0">
            <strong className="block text-lg font-semibold tracking-[-0.02em]">
              {workOrder.properties.title}
            </strong>
            <span className="mt-1.5 block text-sm leading-6 text-muted-foreground">
              {serviceCase.properties.customerImpact}
            </span>
            <span className="mt-2 block text-xs text-muted-foreground">
              {serviceCase.links.customer?.properties.name ?? "Customer"} ·{" "}
              {serviceCase.links.facility?.properties.name ?? "Facility"} ·{" "}
              {equipment.properties.name}
            </span>
          </span>
          <span className="xl:text-right">
            <strong className="block font-mono text-sm font-semibold text-[color:var(--warning)]">
              {deadlineLabel(serviceCase.properties.responseDeadline)}
            </strong>
            <span className="mt-2 block text-xs text-muted-foreground">
              Scheduled {formatDateTime(visit.properties.scheduledStart)}
            </span>
            <Link
              to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-foreground"
            >
              Open service case <ChevronRight className="size-4" strokeWidth={1.7} />
            </Link>
          </span>
        </div>
      </section>

      <WorkSequence visit={visit} />

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(330px,0.85fr)]">
        <VisitAction
          visit={visit}
          finding={finding}
          disposition={disposition}
          workPerformed={workPerformed}
          setFinding={setFinding}
          setDisposition={setDisposition}
          setWorkPerformed={setWorkPerformed}
          starting={starting}
          recording={recording}
          completing={completing}
          onStart={onStart}
          onRecordDiagnosis={onRecordDiagnosis}
          onComplete={onComplete}
        />

        <VisitContext
          visit={visit}
          workOrder={workOrder}
          serviceCase={serviceCase}
          equipment={equipment}
          latestNote={notes[0]}
        />
      </div>
    </>
  )
}

function VisitAction({
  visit,
  finding,
  disposition,
  workPerformed,
  setFinding,
  setDisposition,
  setWorkPerformed,
  starting,
  recording,
  completing,
  onStart,
  onRecordDiagnosis,
  onComplete,
}: {
  visit: VisitRow
  finding: string
  disposition: "resolved_on_site" | "follow_up_required" | "quote_required"
  workPerformed: string
  setFinding: (value: string) => void
  setDisposition: (value: "resolved_on_site" | "follow_up_required" | "quote_required") => void
  setWorkPerformed: (value: string) => void
  starting: boolean
  recording: boolean
  completing: boolean
  onStart: () => void
  onRecordDiagnosis: () => void
  onComplete: () => void
}) {
  if (visit.properties.status === "scheduled") {
    return (
      <ActionSection
        eyebrow="Next field action"
        title="Start service visit"
        description="Confirm arrival before recording site findings or work performed."
      >
        <Button className="mt-5 h-10" disabled={starting} onClick={onStart}>
          {starting ? "Starting…" : "Start visit"}
        </Button>
      </ActionSection>
    )
  }

  if (visit.properties.status === "in_progress" && !visit.properties.diagnosisDisposition) {
    return (
      <ActionSection
        eyebrow="Active field task"
        title="Record diagnosis"
        description="Capture the confirmed condition and determine what should happen next."
      >
        <div className="mt-5 grid gap-4">
          <label className="grid gap-2 text-xs font-semibold">
            Diagnostic finding
            <Textarea
              value={finding}
              onChange={(event) => setFinding(event.target.value)}
              rows={6}
              placeholder="Describe the observed fault, tests performed, and confirmed cause."
              className="resize-none bg-background/60 text-sm font-normal leading-6"
            />
          </label>
          <label className="grid gap-2 text-xs font-semibold">
            Disposition
            <NativeSelect
              value={disposition}
              onChange={(event) => setDisposition(event.target.value as typeof disposition)}
              className="bg-background/60 text-sm font-normal"
            >
              <NativeSelectOption value="resolved_on_site">Resolved on site</NativeSelectOption>
              <NativeSelectOption value="follow_up_required">Follow-up required</NativeSelectOption>
              <NativeSelectOption value="quote_required">Quote required</NativeSelectOption>
            </NativeSelect>
          </label>
          <div className="flex justify-end border-t border-border/85 pt-4">
            <Button
              className="h-10"
              disabled={recording || !finding.trim()}
              onClick={onRecordDiagnosis}
            >
              {recording ? "Recording…" : "Record diagnosis"}
            </Button>
          </div>
        </div>
      </ActionSection>
    )
  }

  if (visit.properties.status === "in_progress" && visit.properties.diagnosisDisposition) {
    return (
      <ActionSection
        eyebrow="Active field task"
        title="Complete visit"
        description="Document the completed work and return the case for recovery verification."
      >
        <div className="mt-5 grid gap-4">
          <div className="rounded-md border border-primary/20 bg-primary/[0.045] px-4 py-3 text-sm">
            <span className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              Recorded disposition
            </span>
            <strong className="mt-1 block font-medium">
              {humanize(visit.properties.diagnosisDisposition)}
            </strong>
          </div>
          <label className="grid gap-2 text-xs font-semibold">
            Work performed
            <Textarea
              value={workPerformed}
              onChange={(event) => setWorkPerformed(event.target.value)}
              rows={6}
              placeholder="Describe the completed work and final equipment condition."
              className="resize-none bg-background/60 text-sm font-normal leading-6"
            />
          </label>
          <div className="flex justify-end border-t border-border/85 pt-4">
            <Button
              className="h-10"
              disabled={completing || !workPerformed.trim()}
              onClick={onComplete}
            >
              {completing ? "Completing…" : "Complete visit"}
            </Button>
          </div>
        </div>
      </ActionSection>
    )
  }

  return (
    <ActionSection
      eyebrow="Visit record"
      title="Field work completed"
      description="This visit is complete and its service record is preserved below."
    >
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
        <CompactDetail label="Disposition">
          {humanize(visit.properties.completionDisposition ?? "completed")}
        </CompactDetail>
        <CompactDetail label="Completed">
          {formatDateTime(visit.properties.completedAt)}
        </CompactDetail>
        <CompactDetail label="Work performed" className="sm:col-span-2">
          {visit.properties.workPerformed ?? "No work summary recorded."}
        </CompactDetail>
      </dl>
    </ActionSection>
  )
}

function VisitContext({
  visit,
  workOrder,
  serviceCase,
  equipment,
  latestNote,
}: {
  visit: VisitRow
  workOrder: NonNullable<VisitRow["links"]["workOrder"]>
  serviceCase: NonNullable<NonNullable<VisitRow["links"]["workOrder"]>["links"]["serviceCase"]>
  equipment: NonNullable<NonNullable<VisitRow["links"]["workOrder"]>["links"]["equipment"]>
  latestNote: NoteRow | undefined
}) {
  const illustration = equipmentIllustration(
    equipment.properties.name,
    equipment.properties.equipmentType
  )
  return (
    <section className="overflow-hidden rounded-lg border border-border/90 bg-card">
      <header className="px-5 pt-4 pb-3">
        <h2 className="text-base font-semibold tracking-[-0.015em]">Visit context</h2>
      </header>
      <div className="px-5 pb-5">
        <Link
          to={`/equipment/${encodeURIComponent(equipment.primaryId)}`}
          className="group flex items-center gap-4 border-t border-border/85 pt-4"
        >
          <span className="grid size-[76px] shrink-0 place-items-center overflow-hidden rounded-lg border border-primary/15 bg-secondary/70">
            <img
              src={illustration.src}
              alt=""
              className={
                illustration.contain ? "size-full object-contain p-1.5" : "size-full object-cover"
              }
            />
          </span>
          <span className="min-w-0">
            <strong className="block text-sm font-semibold group-hover:text-primary">
              {equipment.properties.name}
            </strong>
            <span className="mt-1 block text-xs text-muted-foreground">
              {equipment.properties.manufacturer} · {equipment.properties.model}
            </span>
            <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground">
              {equipment.properties.serialNumber}
            </span>
          </span>
          <ChevronRight className="ml-auto size-5" strokeWidth={1.7} />
        </Link>

        <dl className="mt-5 grid gap-4 border-t border-border/85 pt-4 text-sm">
          <CompactDetail label="Facility">
            {serviceCase.links.facility?.properties.name ?? "Customer facility"}
          </CompactDetail>
          <CompactDetail label="Site access">
            {serviceCase.links.facility?.properties.accessNotes ?? "Check in with facilities."}
          </CompactDetail>
          <CompactDetail label="Authorized scope">{workOrder.properties.scope}</CompactDetail>
          <CompactDetail label="Visit started">
            {formatDateTime(visit.properties.startedAt)}
          </CompactDetail>
        </dl>

        {latestNote ? (
          <div className="mt-5 border-t border-border/85 pt-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                Latest field note
              </p>
              <span className="font-mono text-[9px] text-muted-foreground">
                {formatDateTime(latestNote.properties.recordedAt)}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-foreground">{latestNote.properties.body}</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function ActionSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/90 bg-card px-5 py-5 sm:px-6">
      <p className="text-[10px] font-semibold tracking-[0.16em] text-primary uppercase">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-lg font-semibold tracking-[-0.02em]">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      {children}
    </section>
  )
}

function WorkSequence({ visit }: { visit: VisitRow }) {
  const steps = [
    { label: "Scheduled", complete: true },
    { label: "On site", complete: Boolean(visit.properties.startedAt) },
    { label: "Diagnosis", complete: Boolean(visit.properties.diagnosisDisposition) },
    { label: "Complete", complete: visit.properties.status === "completed" },
  ]
  const current = steps.findIndex((step) => !step.complete)
  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-border/90 bg-card">
      <header className="border-b border-border/80 px-5 py-3">
        <h2 className="text-sm font-semibold">Visit progress</h2>
      </header>
      <ol className="grid grid-cols-2 sm:grid-cols-4">
        {steps.map((step, index) => (
          <li
            key={step.label}
            className="relative flex items-center gap-3 border-r border-border/75 px-4 py-3 last:border-r-0"
          >
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full border ${
                step.complete
                  ? "border-primary bg-primary text-primary-foreground"
                  : index === current
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground"
              }`}
            >
              {step.complete ? <Check className="size-3.5" /> : <Circle className="size-2.5" />}
            </span>
            <span
              className={`text-xs font-semibold ${
                index === current ? "text-primary" : "text-foreground"
              }`}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function MastheadSignal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-border/90 py-1 pr-6 sm:border-r sm:px-6 sm:first:pl-0 sm:last:border-r-0">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xs font-semibold">{children}</dd>
    </div>
  )
}

function CompactDetail({
  label,
  children,
  className = "",
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <dt className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-1.5 text-sm leading-6 text-foreground">{children}</dd>
    </div>
  )
}

function equipmentIllustration(equipmentName: string, equipmentType: string) {
  const normalized = equipmentName.toLowerCase()
  if (normalized === "rtu-2") return { src: "/illustrations/rtu-2.webp", contain: false }
  if (normalized === "rtu-7") return { src: "/illustrations/rtu-7.webp", contain: false }
  if (equipmentType === "rooftop_unit") {
    return { src: "/illustrations/rtu-7.webp", contain: false }
  }
  if (equipmentType === "air_handler") {
    return { src: "/illustrations/ahu-3.webp", contain: false }
  }
  if (equipmentType === "controller") {
    return { src: "/illustrations/building-controller.webp", contain: false }
  }
  if (equipmentType === "boiler") {
    return { src: "/illustrations/boiler-2.webp", contain: true }
  }
  if (equipmentType === "chiller") {
    return { src: "/illustrations/chiller-1.webp", contain: false }
  }
  return { src: "/illustrations/heat-pump-4.webp", contain: false }
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}

function timestamp(value: string | Date | undefined): number {
  return value ? new Date(value).getTime() : 0
}
