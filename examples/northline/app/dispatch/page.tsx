import type { ListWorkflowInterventionsResponse } from "@sixb/client"
import {
  listWorkflowInterventionsOptions,
  listWorkflowInterventionsQueryKey,
  submitWorkflowInterventionMutation,
  useObjectsQuery,
} from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Button } from "@sixb/ui/components"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Check, ChevronLeft, ChevronRight, Filter, LoaderCircle } from "lucide-react"
import type { CSSProperties } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ServiceCase } from "../../ontology/service-case"
import { Technician } from "../../ontology/technician"
import { WorkOrder } from "../../ontology/work-order"
import { deadlineLabel, humanize, QueryState, StatusIndicator } from "../_components/ui"

type Intervention = ListWorkflowInterventionsResponse["interventions"][number]

const techniciansQuery = objects(Technician).query().orderBy(Technician.p.name, "asc").limit(50)

const workOrdersQuery = objects(WorkOrder)
  .query()
  .expand(WorkOrder.l.serviceCase)
  .expand(WorkOrder.l.equipment)
  .expand(WorkOrder.l.assignee)
  .orderBy(WorkOrder.p.scheduledStart, "asc")
  .limit(100)

const serviceCasesQuery = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .limit(100)

const interventionQuery = {
  interventionId: "review-dispatch",
  status: "pending" as const,
  limit: "100",
  order: "desc" as const,
}

const timelineStartHour = 8
const timelineEndHour = 18
const timelineGuideStepMinutes = 2 * 60
const timelineHourWidth = 120
const timelineTechnicianColumnWidth = 250
const timelineDefaultWorkDurationMinutes = 90

interface TimelineRange {
  startMinutes: number
  endMinutes: number
  hours: number[]
}

type TechnicianRow = NonNullable<Awaited<ReturnType<typeof techniciansQuery.first>>>
type WorkOrderRow = NonNullable<Awaited<ReturnType<typeof workOrdersQuery.first>>>
type ServiceCaseRow = NonNullable<Awaited<ReturnType<typeof serviceCasesQuery.first>>>

export default function DispatchPage() {
  const queryClient = useQueryClient()
  const [selectedDate, setSelectedDate] = useState(() => startOfDay(new Date()))
  const [scheduleView, setScheduleView] = useState<"timeline" | "list">("timeline")
  const [showAvailableOnly, setShowAvailableOnly] = useState(false)
  const [reviewingId, setReviewingId] = useState<string>()
  const [submittingId, setSubmittingId] = useState<string>()
  const didChooseInitialDate = useRef(false)
  const technicians = useObjectsQuery(techniciansQuery)
  const workOrders = useObjectsQuery(workOrdersQuery)
  const serviceCases = useObjectsQuery(serviceCasesQuery)
  const reviews = useQuery(listWorkflowInterventionsOptions({ query: interventionQuery }))
  const submit = useMutation({
    ...submitWorkflowInterventionMutation(),
    onSuccess: async () => {
      setReviewingId(undefined)
      await queryClient.invalidateQueries({
        queryKey: listWorkflowInterventionsQueryKey({ query: interventionQuery }),
      })
    },
    onSettled: () => setSubmittingId(undefined),
  })

  const pending = reviews.data?.interventions ?? []
  const caseRows = serviceCases.data?.objects ?? []
  const activeWork = (workOrders.data?.objects ?? []).filter(
    (item) => !["completed", "cancelled"].includes(item.properties.status)
  )
  useEffect(() => {
    if (didChooseInitialDate.current || workOrders.isLoading || activeWork.length === 0) return
    didChooseInitialDate.current = true
    const hasWorkToday = activeWork.some((item) =>
      item.properties.scheduledStart
        ? isSameDay(new Date(item.properties.scheduledStart), selectedDate)
        : false
    )
    const firstScheduledStart = activeWork.find((item) => item.properties.scheduledStart)
      ?.properties.scheduledStart
    if (!hasWorkToday && firstScheduledStart) {
      setSelectedDate(startOfDay(new Date(firstScheduledStart)))
    }
  }, [activeWork, selectedDate, workOrders.isLoading])
  const workOnSelectedDate = useMemo(
    () =>
      activeWork.filter((item) =>
        item.properties.scheduledStart
          ? isSameDay(new Date(item.properties.scheduledStart), selectedDate)
          : false
      ),
    [activeWork, selectedDate]
  )
  const technicianRows = useMemo(() => {
    const rows = (technicians.data?.objects ?? []).filter(
      (technician) => technician.properties.availability !== "off_duty"
    )
    return [...rows].sort((left, right) => {
      const leftHasWork = workOnSelectedDate.some(
        (workOrder) => workOrder.links.assignee?.primaryId === left.primaryId
      )
      const rightHasWork = workOnSelectedDate.some(
        (workOrder) => workOrder.links.assignee?.primaryId === right.primaryId
      )
      if (leftHasWork !== rightHasWork) return leftHasWork ? -1 : 1
      return left.properties.name.localeCompare(right.properties.name)
    })
  }, [technicians.data?.objects, workOnSelectedDate])

  return (
    <div className="pb-8">
      <header className="mb-6 flex items-start justify-between gap-6 max-md:flex-col">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Field coordination
          </p>
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
            Dispatch
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Assign urgent work and coordinate today&apos;s field capacity.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <StatusIndicator
              value="active"
              label={`${technicianRows.length} technicians on duty`}
            />
            <span className="h-4 w-px bg-border" aria-hidden="true" />
            <StatusIndicator
              value={pending.length > 0 ? "urgent" : "available"}
              label={
                pending.length === 0
                  ? "No work needs assignment"
                  : pending.length === 1
                    ? "1 needs assignment"
                    : `${pending.length} need assignment`
              }
            />
          </div>
        </div>

        <DateControl
          date={selectedDate}
          onPrevious={() => setSelectedDate((current) => shiftDate(current, -1))}
          onNext={() => setSelectedDate((current) => shiftDate(current, 1))}
          onToday={() => setSelectedDate(startOfDay(new Date()))}
        />
      </header>

      <section className="overflow-hidden rounded-xl border border-border/90 bg-card">
        <header className="px-5 pt-5 pb-3">
          <h2 className="text-base font-semibold tracking-[-0.015em]">Needs assignment</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Unscheduled work ordered by customer impact.
          </p>
        </header>

        <QueryState
          loading={reviews.isLoading || serviceCases.isLoading}
          error={reviews.isError || serviceCases.isError}
          empty={pending.length === 0}
          emptyMessage="All urgent work is assigned."
        >
          <div className="divide-y divide-border/75">
            {pending.map((intervention) => {
              const serviceCaseRef = objectRef(intervention.input.serviceCase)
              const serviceCase = caseRows.find(
                (item) => item.primaryId === serviceCaseRef?.primaryId
              )
              const technicianRef =
                objectRef(intervention.defaultResponse.technician) ??
                objectRef(intervention.input.recommendedTechnician)
              const recommended = technicianRows.find(
                (technician) => technician.primaryId === technicianRef?.primaryId
              )
              return (
                <AssignmentRow
                  key={intervention.id}
                  intervention={intervention}
                  serviceCase={serviceCase}
                  recommended={recommended}
                  reviewing={reviewingId === intervention.id}
                  submitting={submit.isPending && submittingId === intervention.id}
                  onReview={() => setReviewingId(intervention.id)}
                  onCancel={() => setReviewingId(undefined)}
                  onApprove={(response) => {
                    setSubmittingId(intervention.id)
                    submit.mutate({
                      path: { interventionId: intervention.id },
                      body: { response },
                    })
                  }}
                />
              )
            })}
          </div>
        </QueryState>
      </section>

      <section className="mt-4 overflow-hidden rounded-xl border border-border/90 bg-card">
        <header className="flex items-center justify-between gap-5 px-5 py-5 max-sm:items-start">
          <div>
            <h2 className="text-base font-semibold tracking-[-0.015em]">
              {isToday(selectedDate)
                ? "Today’s field schedule"
                : formatScheduleHeading(selectedDate)}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Live assignments and open capacity by technician.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="flex overflow-hidden rounded-md border border-border bg-background">
              <button
                type="button"
                aria-pressed={scheduleView === "timeline"}
                className={
                  scheduleView === "timeline"
                    ? "h-9 bg-primary px-4 text-xs font-semibold text-primary-foreground"
                    : "h-9 px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                }
                onClick={() => setScheduleView("timeline")}
              >
                Timeline
              </button>
              <button
                type="button"
                aria-pressed={scheduleView === "list"}
                className={
                  scheduleView === "list"
                    ? "h-9 border-l border-border bg-primary px-4 text-xs font-semibold text-primary-foreground"
                    : "h-9 border-l border-border px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                }
                onClick={() => setScheduleView("list")}
              >
                List
              </button>
            </div>
            <button
              type="button"
              aria-label="Show available technicians only"
              aria-pressed={showAvailableOnly}
              title="Show available technicians only"
              className={
                showAvailableOnly
                  ? "grid size-9 place-items-center rounded-md border border-primary bg-primary text-primary-foreground"
                  : "grid size-9 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/45 hover:text-primary"
              }
              onClick={() => setShowAvailableOnly((current) => !current)}
            >
              <Filter className="size-4" strokeWidth={1.8} />
            </button>
          </div>
        </header>

        <QueryState
          loading={technicians.isLoading || workOrders.isLoading}
          error={technicians.isError || workOrders.isError}
          empty={technicianRows.length === 0}
          emptyMessage="No technicians are on duty."
        >
          {scheduleView === "timeline" ? (
            <ScheduleTimeline
              date={selectedDate}
              technicians={technicianRows.filter(
                (technician) =>
                  !showAvailableOnly || technician.properties.availability === "available"
              )}
              workOrders={workOnSelectedDate}
              pending={pending}
            />
          ) : (
            <ScheduleList
              technicians={technicianRows.filter(
                (technician) =>
                  !showAvailableOnly || technician.properties.availability === "available"
              )}
              workOrders={workOnSelectedDate}
            />
          )}
        </QueryState>
      </section>
    </div>
  )
}

function DateControl({
  date,
  onPrevious,
  onNext,
  onToday,
}: {
  date: Date
  onPrevious(): void
  onNext(): void
  onToday(): void
}) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="flex h-10 items-center overflow-hidden rounded-md border border-border bg-card">
        <button
          type="button"
          className="grid h-full w-10 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Previous day"
          onClick={onPrevious}
        >
          <ChevronLeft className="size-4" strokeWidth={1.8} />
        </button>
        <span className="min-w-36 border-x border-border px-4 text-center text-xs font-medium tracking-[0.02em] text-foreground uppercase">
          {new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          }).format(date)}
        </span>
        <button
          type="button"
          className="grid h-full w-10 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Next day"
          onClick={onNext}
        >
          <ChevronRight className="size-4" strokeWidth={1.8} />
        </button>
      </div>
      <button
        type="button"
        className="h-10 rounded-md border border-border bg-card px-4 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/45 hover:text-foreground"
        onClick={onToday}
      >
        Today
      </button>
    </div>
  )
}

function AssignmentRow({
  intervention,
  serviceCase,
  recommended,
  reviewing,
  submitting,
  onReview,
  onCancel,
  onApprove,
}: {
  intervention: Intervention
  serviceCase: ServiceCaseRow | undefined
  recommended: TechnicianRow | undefined
  reviewing: boolean
  submitting: boolean
  onReview(): void
  onCancel(): void
  onApprove(response: Record<string, unknown>): void
}) {
  const technician =
    objectRef(intervention.defaultResponse.technician) ??
    objectRef(intervention.input.recommendedTechnician)
  const scheduledStart =
    intervention.defaultResponse.scheduledStart ?? intervention.input.scheduledStart
  const scheduledEnd = intervention.defaultResponse.scheduledEnd ?? intervention.input.scheduledEnd
  const equipment = serviceCase?.links.equipment?.properties

  return (
    <article className="group mx-3 mb-3 overflow-hidden rounded-xl border border-primary/65 bg-primary/[0.035] transition-[background-color,box-shadow] hover:bg-primary/[0.055] hover:shadow-[0_1px_2px_rgba(13,32,39,0.04)]">
      <div className="grid items-center gap-5 px-5 py-4 lg:grid-cols-[96px_minmax(280px,1.4fr)_145px_minmax(230px,0.72fr)_auto]">
        <EquipmentThumbnail
          equipmentName={equipment?.name ?? text(intervention.input.title, "Equipment")}
          equipmentType={equipment?.equipmentType}
        />

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <strong className="font-mono text-xs font-semibold">
              {serviceCase?.properties.number ??
                text(intervention.input.caseNumber, "Service case")}
            </strong>
            <StatusIndicator value={serviceCase?.properties.severity ?? "urgent"} />
          </div>
          <Link
            to={
              serviceCase
                ? `/service-cases/${encodeURIComponent(serviceCase.primaryId)}`
                : "/service-cases"
            }
            className="mt-1.5 block truncate text-sm font-semibold tracking-[-0.012em] text-foreground hover:text-primary"
          >
            {serviceCase?.properties.title ?? text(intervention.input.title, "Dispatch review")}
          </Link>
          <p className="mt-1 text-xs font-medium text-foreground/85">
            {serviceCase?.links.customer?.properties.name ?? "Customer"}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {serviceCase?.links.facility?.properties.name ?? "Facility"} ·{" "}
            {equipment?.name ?? "Equipment"}
          </p>
        </div>

        <strong className="font-mono text-xs text-destructive lg:text-center">
          {serviceCase ? deadlineLabel(serviceCase.properties.responseDeadline) : "Needs review"}
        </strong>

        <div className="border-border/80 lg:border-l lg:pl-6">
          <span className="text-[11px] text-muted-foreground">Best fit</span>
          <div className="mt-2 flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-primary/35 bg-card font-mono text-[11px] font-medium text-primary">
              {initials(recommended?.properties.name ?? "Technician")}
            </span>
            <span className="min-w-0">
              <strong className="block truncate text-xs font-semibold">
                {recommended?.properties.name ?? "Recommended technician"}
              </strong>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {recommended
                  ? `${humanize(recommended.properties.territory)} · ${humanize(recommended.properties.certification)}`
                  : "Qualification pending"}
              </span>
            </span>
          </div>
          <StatusIndicator
            value="available"
            label={`Available ${formatUnknownTime(scheduledStart)}`}
            className="mt-2 ml-11"
          />
        </div>

        <Button
          className="h-10 justify-between gap-5 px-4 text-xs"
          disabled={!technician}
          onClick={onReview}
        >
          Review assignment <ArrowRight className="size-4" />
        </Button>
      </div>

      {reviewing ? (
        <div className="flex items-center justify-between gap-5 border-t border-primary/20 bg-card/75 px-5 py-4 max-md:flex-col max-md:items-stretch">
          <div className="min-w-0">
            <p className="text-xs leading-5 text-muted-foreground">
              {text(intervention.input.recommendation, "Review the recommended assignment.")}
            </p>
            <p className="mt-1 font-mono text-[11px] text-foreground">
              {formatUnknownDate(scheduledStart)} – {formatUnknownTime(scheduledEnd)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" disabled={submitting} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={submitting || !technician}
              onClick={() => onApprove({ technician, scheduledStart, scheduledEnd })}
            >
              {submitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {submitting ? "Approving…" : "Approve dispatch"}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  )
}

function EquipmentThumbnail({
  equipmentName,
  equipmentType,
}: {
  equipmentName: string
  equipmentType: string | undefined
}) {
  const illustration = equipmentIllustration(equipmentName, equipmentType)

  return (
    <span className="grid size-20 place-items-center overflow-hidden rounded-lg border border-primary/15 bg-secondary/75">
      {illustration ? (
        <img src={illustration} alt="" className="size-full object-cover" />
      ) : (
        <span className="grid size-12 place-items-center rounded-lg border border-primary/25 bg-primary/10 font-mono text-[10px] font-semibold text-primary uppercase">
          HVAC
        </span>
      )}
      <span className="sr-only">{equipmentName}</span>
    </span>
  )
}

function ScheduleList({
  technicians,
  workOrders,
}: {
  technicians: TechnicianRow[]
  workOrders: WorkOrderRow[]
}) {
  const technicianIds = new Set(technicians.map((technician) => technician.primaryId))
  const visibleWork = workOrders.filter((workOrder) => {
    const assigneeId = workOrder.links.assignee?.primaryId
    return !assigneeId || technicianIds.has(assigneeId)
  })

  if (visibleWork.length === 0) {
    return (
      <p className="border-t border-border/80 px-5 py-12 text-center text-sm text-muted-foreground">
        No work is scheduled for this view.
      </p>
    )
  }

  return (
    <div className="divide-y divide-border/75 border-t border-border/80">
      {visibleWork.map((workOrder) => (
        <Link
          key={workOrder.primaryId}
          to={`/service-cases/${encodeURIComponent(workOrder.links.serviceCase?.primaryId ?? "")}`}
          className="group grid items-center gap-4 px-5 py-4 transition-colors hover:bg-accent/45 md:grid-cols-[120px_minmax(0,1fr)_200px_120px_auto]"
        >
          <span className="font-mono text-xs font-semibold">
            {formatUnknownTime(workOrder.properties.scheduledStart)}
            <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
              to {formatUnknownTime(workOrder.properties.scheduledEnd)}
            </span>
          </span>
          <span className="min-w-0">
            <strong className="block truncate font-mono text-[10px]">
              {workOrder.properties.number}
            </strong>
            <span className="mt-1 block truncate text-xs font-semibold group-hover:text-primary">
              {workOrder.properties.title}
            </span>
          </span>
          <span className="min-w-0 text-xs">
            <strong className="block truncate font-medium">
              {workOrder.links.equipment?.properties.name ?? "Equipment"}
            </strong>
            <span className="mt-1 block truncate text-[10px] text-muted-foreground">
              {workOrder.links.assignee?.properties.name ?? "Unassigned"}
            </span>
          </span>
          <StatusIndicator value={workOrder.properties.status} />
          <ArrowRight
            className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
            strokeWidth={1.8}
          />
        </Link>
      ))}
    </div>
  )
}

function ScheduleTimeline({
  date,
  technicians,
  workOrders,
  pending,
}: {
  date: Date
  technicians: TechnicianRow[]
  workOrders: WorkOrderRow[]
  pending: Intervention[]
}) {
  const now = new Date()
  const range = createTimelineRange(date, workOrders)
  const nowPosition = isSameDay(date, now) ? timePosition(now, date, range) : undefined
  const timelineWidth = ((range.endMinutes - range.startMinutes) / 60) * timelineHourWidth
  const timelineCanvasStyle = {
    width: timelineTechnicianColumnWidth + timelineWidth,
  } satisfies CSSProperties
  const timelineGridStyle = {
    gridTemplateColumns: `${timelineTechnicianColumnWidth}px ${timelineWidth}px`,
  } satisfies CSSProperties

  return (
    <div
      className="overflow-x-auto overscroll-x-contain border-t border-border/80 [scrollbar-gutter:stable]"
      role="region"
      aria-label="Technician schedule timeline"
      tabIndex={0}
    >
      <div style={timelineCanvasStyle}>
        <div className="grid border-b border-border/80" style={timelineGridStyle}>
          <div className="border-r border-border/70 bg-card md:sticky md:left-0 md:z-30" />
          <div className="relative h-11">
            <TimelineGuides range={range} />
            {range.hours.map((hour) => (
              <span
                key={hour}
                className="absolute top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground"
                style={timeLabelStyle(hour, range)}
              >
                {formatHour(hour)}
              </span>
            ))}
            {nowPosition !== undefined ? (
              <span
                className="absolute top-0 z-20 -translate-x-1/2 bg-card px-1.5 font-mono text-[10px] font-semibold tracking-[0.04em] text-primary"
                style={{ left: `${nowPosition}%` }}
              >
                NOW {formatTimelineTime(now)}
              </span>
            ) : null}
          </div>
        </div>

        {technicians.map((technician) => {
          const assignedWork = workOrders.filter(
            (workOrder) => workOrder.links.assignee?.primaryId === technician.primaryId
          )
          const availabilityStart = recommendedAvailabilityStart(technician, pending, date, now)
          return (
            <div
              key={technician.primaryId}
              className="grid min-h-[66px] border-b border-border/70 last:border-b-0"
              style={timelineGridStyle}
            >
              <Link
                to={`/technicians/${encodeURIComponent(technician.primaryId)}`}
                className="group flex items-center gap-3 border-r border-border/70 bg-card px-5 py-3 transition-colors hover:bg-accent/55 md:sticky md:left-0 md:z-20"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] font-medium text-foreground">
                  {initials(technician.properties.name)}
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-xs font-semibold group-hover:text-primary">
                    {technician.properties.name}
                  </strong>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    {humanize(technician.properties.territory)} ·{" "}
                    {humanize(technician.properties.certification)}
                  </span>
                </span>
              </Link>

              <div className="relative min-h-[66px] overflow-hidden">
                <TimelineGuides range={range} />
                {availabilityStart && assignedWork.length === 0 ? (
                  <div
                    className="absolute top-3 h-10 rounded-lg border border-dashed border-[color:var(--success)]/55 bg-[color:var(--success)]/[0.025]"
                    style={availabilityStyle(availabilityStart, date, range)}
                  >
                    <span className="absolute top-1/2 right-3 -translate-y-1/2 text-[10px] font-medium text-[color:var(--success)]">
                      Available
                    </span>
                  </div>
                ) : null}
                {assignedWork.map((workOrder) => (
                  <ScheduleBlock
                    key={workOrder.primaryId}
                    workOrder={workOrder}
                    date={date}
                    range={range}
                  />
                ))}
                {nowPosition !== undefined ? (
                  <span
                    className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary/85"
                    style={{ left: `${nowPosition}%` }}
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            </div>
          )
        })}

        <div className="flex h-12 items-center gap-7 border-t border-border/20 px-5 text-[10px] text-muted-foreground">
          <LegendDot className="bg-primary" label="On site" />
          <LegendDot className="bg-[color:var(--info)]" label="Dispatched" />
          <LegendDot className="bg-destructive" label="Paused" />
          <span className="inline-flex items-center gap-2">
            <span className="size-3 rounded-[3px] border border-dashed border-[color:var(--success)]/60" />
            Available
          </span>
        </div>
      </div>
    </div>
  )
}

function ScheduleBlock({
  workOrder,
  date,
  range,
}: {
  workOrder: WorkOrderRow
  date: Date
  range: TimelineRange
}) {
  const href = `/service-cases/${encodeURIComponent(workOrder.links.serviceCase?.primaryId ?? "")}`
  const style = scheduleBlockStyle(
    workOrder.properties.scheduledStart,
    workOrder.properties.scheduledEnd,
    date,
    range
  )

  return (
    <Link
      to={href}
      className={`absolute top-2.5 z-[5] h-11 min-w-[118px] overflow-hidden rounded-lg border px-3 py-1.5 transition-[filter,box-shadow] hover:brightness-[0.985] hover:shadow-sm ${scheduleTone(workOrder.properties.status)}`}
      style={style}
    >
      <span className="flex items-center justify-between gap-2">
        <strong className="truncate font-mono text-[10px] font-semibold">
          {workOrder.properties.number}
        </strong>
        <StatusIndicator value={workOrder.properties.status} />
      </span>
      <span className="mt-0.5 block truncate text-[10px] font-medium">
        {workOrder.links.equipment?.properties.name ?? "Equipment"}
      </span>
    </Link>
  )
}

function TimelineGuides({ range }: { range: TimelineRange }) {
  return (
    <>
      {range.hours.map((hour) => (
        <span
          key={hour}
          className="pointer-events-none absolute inset-y-0 w-px bg-border/55"
          style={{ left: `${hourPosition(hour, range)}%` }}
          aria-hidden="true"
        />
      ))}
    </>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`size-1.5 rounded-full ${className}`} />
      {label}
    </span>
  )
}

function scheduleTone(status: string): string {
  if (status === "paused") {
    return "border-destructive/45 bg-destructive/[0.07] text-destructive"
  }
  if (status === "dispatched" || status === "en_route") {
    return "border-[color:var(--info)]/45 bg-[color:var(--info)]/[0.07] text-[color:var(--info)]"
  }
  return "border-primary/50 bg-primary/[0.075] text-primary"
}

function scheduleBlockStyle(
  startValue: string | Date | undefined,
  endValue: string | Date | undefined,
  date: Date,
  range: TimelineRange
): CSSProperties {
  const fallbackWidth =
    (timelineDefaultWorkDurationMinutes / (range.endMinutes - range.startMinutes)) * 100
  if (!startValue) return { left: "0%", width: `${fallbackWidth}%` }
  const left = timePosition(new Date(startValue), date, range)
  const right = endValue
    ? timePosition(new Date(endValue), date, range)
    : Math.min(100, left + fallbackWidth)
  return {
    left: `${left}%`,
    width: `${Math.max(8, right - left)}%`,
  }
}

function availabilityStyle(start: Date, date: Date, range: TimelineRange): CSSProperties {
  const left = timePosition(start, date, range)
  return {
    left: `${left}%`,
    width: `${Math.max(0, 100 - left - 1)}%`,
  }
}

function recommendedAvailabilityStart(
  technician: TechnicianRow,
  pending: Intervention[],
  date: Date,
  now: Date
): Date | undefined {
  if (technician.properties.availability !== "available") return undefined

  const matchingReview = pending.find((intervention) => {
    const technicianRef =
      objectRef(intervention.defaultResponse.technician) ??
      objectRef(intervention.input.recommendedTechnician)
    return technicianRef?.primaryId === technician.primaryId
  })
  const recommendedStart = matchingReview
    ? (matchingReview.defaultResponse.scheduledStart ?? matchingReview.input.scheduledStart)
    : undefined
  if (
    (typeof recommendedStart === "string" || recommendedStart instanceof Date) &&
    isSameDay(new Date(recommendedStart), date)
  ) {
    return new Date(recommendedStart)
  }
  if (isSameDay(date, now)) return now

  const start = new Date(date)
  start.setHours(timelineStartHour, 0, 0, 0)
  return start
}

function equipmentIllustration(equipmentName: string, equipmentType: string | undefined) {
  const normalized = equipmentName.toLowerCase()
  if (normalized.includes("rtu-2")) return "/illustrations/rtu-2.webp"
  if (normalized.includes("rtu-7")) return "/illustrations/rtu-7.webp"
  if (normalized.includes("ahu-3")) return "/illustrations/ahu-3.webp"
  if (normalized.includes("controller")) return "/illustrations/building-controller.webp"
  if (equipmentType === "boiler") return "/illustrations/boiler-2.webp"
  return undefined
}

function createTimelineRange(date: Date, workOrders: WorkOrderRow[]): TimelineRange {
  let startMinutes = timelineStartHour * 60
  let endMinutes = timelineEndHour * 60

  for (const workOrder of workOrders) {
    const scheduledStart = minutesFromDayStart(workOrder.properties.scheduledStart, date)
    const scheduledEnd = minutesFromDayStart(workOrder.properties.scheduledEnd, date)
    if (scheduledStart !== undefined) {
      startMinutes = Math.min(
        startMinutes,
        Math.floor(scheduledStart / timelineGuideStepMinutes) * timelineGuideStepMinutes
      )
      endMinutes = Math.max(
        endMinutes,
        Math.ceil(
          (scheduledStart + timelineDefaultWorkDurationMinutes) / timelineGuideStepMinutes
        ) * timelineGuideStepMinutes
      )
    }
    if (scheduledEnd !== undefined) {
      endMinutes = Math.max(
        endMinutes,
        Math.ceil(scheduledEnd / timelineGuideStepMinutes) * timelineGuideStepMinutes
      )
    }
  }

  startMinutes = Math.max(0, startMinutes)
  endMinutes = Math.min(24 * 60, endMinutes)
  const hours: number[] = []
  for (let minutes = startMinutes; minutes <= endMinutes; minutes += timelineGuideStepMinutes) {
    hours.push(minutes / 60)
  }

  return { startMinutes, endMinutes, hours }
}

function minutesFromDayStart(value: string | Date | undefined, date: Date): number | undefined {
  if (!value) return undefined
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return undefined
  return (timestamp.getTime() - startOfDay(date).getTime()) / 60_000
}

function timePosition(value: Date, date: Date, range: TimelineRange): number {
  const minutes = minutesFromDayStart(value, date) ?? range.startMinutes
  return Math.min(
    100,
    Math.max(0, ((minutes - range.startMinutes) / (range.endMinutes - range.startMinutes)) * 100)
  )
}

function hourPosition(hour: number, range: TimelineRange): number {
  return ((hour * 60 - range.startMinutes) / (range.endMinutes - range.startMinutes)) * 100
}

function timeLabelStyle(hour: number, range: TimelineRange): CSSProperties {
  const position = hourPosition(hour, range)
  if (position === 0) return { left: 12 }
  if (position === 100) return { right: 12 }
  return { left: `${position}%`, transform: "translate(-50%, -50%)" }
}

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2026, 0, 1, hour))
}

function formatTimelineTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(value)
    .replace(" ", "")
}

function formatUnknownDate(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "Window pending"
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatUnknownTime(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "pending"
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(value)
  )
}

function formatScheduleHeading(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date)
}

function shiftDate(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return startOfDay(next)
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date())
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}

function objectRef(value: unknown): { objectTypeId: string; primaryId: string } | null {
  if (!value || typeof value !== "object") return null
  const ref = value as { objectTypeId?: unknown; primaryId?: unknown }
  return typeof ref.objectTypeId === "string" && typeof ref.primaryId === "string"
    ? { objectTypeId: ref.objectTypeId, primaryId: ref.primaryId }
    : null
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}
