import type {
  ListWorkflowInterventionsResponse,
  SubmitWorkflowInterventionData,
} from "@sixb/client"
import {
  listWorkflowInterventionsOptions,
  listWorkflowInterventionsQueryKey,
  submitWorkflowInterventionMutation,
  useObjectsQuery,
} from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Check, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ServiceCase } from "../../ontology/service-case"
import { Technician } from "../../ontology/technician"
import { WorkOrder } from "../../ontology/work-order"
import {
  CaseClockText,
  formatTime,
  humanize,
  PageHeader,
  QueryState,
  Section,
  StatusBadge,
  StatusIndicator,
} from "../_components/ui"
import { equipmentIcon, equipmentIllustration } from "../_lib/equipment"
import type { QueryRow } from "../_lib/query-types"

type Intervention = ListWorkflowInterventionsResponse["interventions"][number]
type InterventionResponse = SubmitWorkflowInterventionData["body"]["response"]

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
/** The visible range widens in two-hour steps to fit work scheduled outside the working day. */
const timelineSnapMinutes = 2 * 60
const timelineHourWidth = 80
const timelineTechnicianColumnWidth = 224
const timelineDefaultWorkDurationMinutes = 90

interface TimelineRange {
  startMinutes: number
  endMinutes: number
  hours: number[]
}

type TechnicianRow = QueryRow<typeof techniciansQuery>
type WorkOrderRow = QueryRow<typeof workOrdersQuery>
type ServiceCaseRow = QueryRow<typeof serviceCasesQuery>

const primaryPill =
  "inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
const secondaryPill =
  "inline-flex h-10 items-center gap-2 rounded-full bg-black/[0.05] px-5 text-[14px] font-semibold text-foreground transition-colors hover:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60 dark:bg-white/[0.08] dark:hover:bg-white/[0.12]"

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
  const visibleTechnicians = technicianRows.filter(
    (technician) => !showAvailableOnly || technician.properties.availability === "available"
  )
  const availableCount = technicianRows.filter(
    (technician) => technician.properties.availability === "available"
  ).length

  const reviewsLoading = reviews.isLoading || serviceCases.isLoading
  const reviewsError = reviews.isError || serviceCases.isError

  return (
    <div className="pb-8">
      <PageHeader
        title="Dispatch"
        description="Approve the recommended assignments and coordinate the day’s field capacity."
        action={
          <DateControl
            date={selectedDate}
            onPrevious={() => setSelectedDate((current) => shiftDate(current, -1))}
            onNext={() => setSelectedDate((current) => shiftDate(current, 1))}
            onToday={() => setSelectedDate(startOfDay(new Date()))}
          />
        }
      >
        <dl className="flex flex-wrap gap-x-9 gap-y-3">
          <Fact label="Needs assignment">
            {reviews.isLoading ? (
              "—"
            ) : pending.length === 0 ? (
              "Nothing waiting"
            ) : (
              <span className="text-[color:var(--warning)]">{count(pending.length, "case")}</span>
            )}
          </Fact>
          <Fact label="On duty">
            {technicians.isLoading ? "—" : count(technicianRows.length, "technician")}
          </Fact>
          <Fact label="Available">
            {technicians.isLoading ? "—" : `${availableCount} of ${technicianRows.length}`}
          </Fact>
          <Fact label="Scheduled">
            {workOrders.isLoading ? "—" : count(workOnSelectedDate.length, "job")}
          </Fact>
        </dl>
      </PageHeader>

      <div className="flex flex-col gap-10">
        <section aria-labelledby="dispatch-reviews" className="flex flex-col gap-4">
          <header>
            <h2
              id="dispatch-reviews"
              className="text-[19px] leading-6 font-semibold tracking-[-0.015em]"
            >
              Needs assignment
            </h2>
            <p className="mt-1 text-[13.5px] leading-5 text-muted-foreground">
              Northline recommends a technician and window for each case. Review it, then approve to
              dispatch.
            </p>
          </header>

          {!reviewsLoading && !reviewsError && pending.length > 0 ? (
            <ul className="flex flex-col gap-4">
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
                  <li key={intervention.id}>
                    <DispatchDecision
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
                  </li>
                )
              })}
            </ul>
          ) : (
            <Section>
              <QueryState
                loading={reviewsLoading}
                error={reviewsError}
                empty={pending.length === 0}
                emptyMessage="All urgent work is assigned."
              />
            </Section>
          )}
        </section>

        <section className="overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
          <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 px-6 pt-5 pb-4">
            <div className="min-w-0">
              <h2 className="text-[19px] leading-6 font-semibold tracking-[-0.015em]">
                {isToday(selectedDate)
                  ? "Today’s field schedule"
                  : formatScheduleHeading(selectedDate)}
              </h2>
              <p className="mt-1 text-[13.5px] leading-5 text-muted-foreground">
                Live assignments and open capacity by technician.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Schedule view"
                className="inline-flex h-9 items-center rounded-full bg-black/[0.05] p-0.5 dark:bg-white/[0.08]"
              >
                <ViewButton
                  active={scheduleView === "timeline"}
                  onClick={() => setScheduleView("timeline")}
                >
                  Timeline
                </ViewButton>
                <ViewButton
                  active={scheduleView === "list"}
                  onClick={() => setScheduleView("list")}
                >
                  List
                </ViewButton>
              </div>
              <button
                type="button"
                aria-pressed={showAvailableOnly}
                title="Show available technicians only"
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  showAvailableOnly
                    ? "bg-foreground text-background"
                    : "bg-black/[0.05] text-foreground/80 hover:bg-black/[0.08] dark:bg-white/[0.08]"
                )}
                onClick={() => setShowAvailableOnly((current) => !current)}
              >
                {showAvailableOnly ? <Check className="size-3.5" strokeWidth={2.4} /> : null}
                Available only
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
                technicians={visibleTechnicians}
                workOrders={workOnSelectedDate}
                pending={pending}
              />
            ) : (
              <ScheduleList technicians={visibleTechnicians} workOrders={workOnSelectedDate} />
            )}
          </QueryState>
        </section>
      </div>
    </div>
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
  const stepButton =
    "grid size-8 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-card hover:text-foreground hover:shadow-[var(--shadow-card)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

  return (
    <div className="flex items-center gap-2">
      <div className="flex h-10 items-center rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.08]">
        <button type="button" className={stepButton} aria-label="Previous day" onClick={onPrevious}>
          <ChevronLeft className="size-4" strokeWidth={2} />
        </button>
        <span
          aria-live="polite"
          className="min-w-[7.5rem] px-2 text-center text-[14px] font-semibold tabular-nums"
        >
          {new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          }).format(date)}
        </span>
        <button type="button" className={stepButton} aria-label="Next day" onClick={onNext}>
          <ChevronRight className="size-4" strokeWidth={2} />
        </button>
      </div>
      <button type="button" className={secondaryPill} onClick={onToday}>
        Today
      </button>
    </div>
  )
}

function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick(): void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "h-8 rounded-full px-4 text-[13.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active
          ? "bg-card text-foreground shadow-[var(--shadow-card)]"
          : "text-foreground/70 hover:text-foreground"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** One pending dispatch review, framed like the service case's next step. */
function DispatchDecision({
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
  onApprove(response: InterventionResponse): void
}) {
  const technician =
    objectRef(intervention.defaultResponse.technician) ??
    objectRef(intervention.input.recommendedTechnician)
  const scheduledStart =
    intervention.defaultResponse.scheduledStart ?? intervention.input.scheduledStart
  const scheduledEnd = intervention.defaultResponse.scheduledEnd ?? intervention.input.scheduledEnd
  const equipment = serviceCase?.links.equipment?.properties
  const illustration = equipmentIllustration(equipment?.name, equipment?.equipmentType)
  const EquipmentIcon = equipmentIcon(equipment?.equipmentType)
  const duration = durationLabel(scheduledStart, scheduledEnd)

  return (
    <article className="flex flex-col gap-5 rounded-[20px] bg-card p-6 shadow-[0_0_0_1.5px_var(--primary),0_10px_28px_color-mix(in_srgb,var(--primary)_12%,transparent)] max-sm:p-5">
      <div className="flex items-start gap-5 max-sm:gap-4">
        <span className="flex size-[88px] shrink-0 items-center justify-center overflow-hidden rounded-[16px] bg-muted max-sm:size-16">
          {illustration ? (
            <img
              src={illustration.src}
              alt=""
              className={cn(
                "size-full",
                illustration.contain ? "object-contain p-2" : "object-cover"
              )}
            />
          ) : (
            <EquipmentIcon className="size-7 text-foreground/45" strokeWidth={1.5} />
          )}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            <span className="text-[12px] font-semibold text-primary">Dispatch recommendation</span>
            <span className="flex items-center gap-2.5">
              {serviceCase ? (
                <CaseClockText
                  serviceCase={serviceCase.properties}
                  className="text-[13px] font-medium text-foreground/70"
                />
              ) : (
                <span className="text-[13px] font-medium text-foreground/70">Needs review</span>
              )}
              <StatusBadge value={serviceCase?.properties.severity ?? "urgent"} />
            </span>
          </div>
          <h3 className="text-[22px] leading-7 font-semibold tracking-[-0.015em] text-balance max-sm:text-[19px] max-sm:leading-6">
            <Link
              to={
                serviceCase
                  ? `/service-cases/${encodeURIComponent(serviceCase.primaryId)}`
                  : "/service-cases"
              }
              className="rounded-[4px] transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {serviceCase?.properties.title ?? text(intervention.input.title, "Dispatch review")}
            </Link>
          </h3>
          <p className="text-[14px] leading-5 text-pretty text-muted-foreground">
            <span className="font-semibold text-foreground/70 tabular-nums">
              {serviceCase?.properties.number ??
                text(intervention.input.caseNumber, "Service case")}
            </span>
            {" · "}
            {serviceCase?.links.customer?.properties.name ?? "Customer"} ·{" "}
            {serviceCase?.links.facility?.properties.name ?? "Facility"} ·{" "}
            {equipment?.name ?? "Equipment"}
          </p>
        </div>
      </div>

      <dl className="grid gap-x-8 gap-y-5 rounded-[16px] bg-muted/70 px-5 py-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <dt className="text-[12px] text-muted-foreground">Recommended technician</dt>
          <dd className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-card text-[13px] font-semibold text-primary shadow-[var(--shadow-card)]">
              {initials(recommended?.properties.name ?? "Technician")}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[15px] leading-5 font-semibold">
                {recommended?.properties.name ?? "Recommended technician"}
              </span>
              <span className="truncate text-[13px] leading-5 text-muted-foreground">
                {recommended
                  ? `${humanize(recommended.properties.territory)} · ${humanize(recommended.properties.certification)}`
                  : "Qualification pending"}
              </span>
              <StatusIndicator
                value="available"
                label={`Available ${formatUnknownTime(scheduledStart)}`}
                className="pt-0.5"
              />
            </span>
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <dt className="text-[12px] text-muted-foreground">Window</dt>
          <dd className="flex flex-col gap-0.5">
            <span className="text-[15px] leading-5 font-semibold tabular-nums">
              {formatUnknownDate(scheduledStart)} – {formatUnknownTime(scheduledEnd)}
            </span>
            {duration ? (
              <span className="text-[13px] leading-5 text-muted-foreground">{duration}</span>
            ) : null}
          </dd>
        </div>
      </dl>

      {reviewing ? (
        <div className="flex flex-col gap-4 border-t border-border/70 pt-5">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-muted-foreground">
              Why this technician
            </span>
            <p className="max-w-2xl text-[15px] leading-6 text-pretty text-foreground/80">
              {text(intervention.input.recommendation, "Review the recommended assignment.")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              className={primaryPill}
              disabled={submitting || !technician}
              onClick={() => onApprove({ technician, scheduledStart, scheduledEnd })}
            >
              {submitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" strokeWidth={2.2} />
              )}
              {submitting ? "Approving…" : "Approve dispatch"}
            </button>
            <button
              type="button"
              className={secondaryPill}
              disabled={submitting}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" className={primaryPill} disabled={!technician} onClick={onReview}>
            Review assignment
            <ArrowRight className="size-4" strokeWidth={2} />
          </button>
        </div>
      )}
    </article>
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
      <p className="border-t border-border/70 px-6 py-12 text-center text-[14px] text-muted-foreground">
        No work is scheduled for this view.
      </p>
    )
  }

  return (
    <ul className="border-t border-border/70">
      {visibleWork.map((workOrder) => (
        <li key={workOrder.primaryId} className="border-t border-border/70 first:border-t-0">
          <Link
            to={`/service-cases/${encodeURIComponent(workOrder.links.serviceCase?.primaryId ?? "")}`}
            className="group grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-4 px-6 py-4 transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none sm:grid-cols-[5.25rem_minmax(0,1fr)_auto_1rem] dark:hover:bg-white/[0.03]"
          >
            <span className="flex flex-col gap-0.5 tabular-nums">
              <span className="text-[15px] leading-5 font-semibold">
                {formatUnknownTime(workOrder.properties.scheduledStart)}
              </span>
              <span className="text-[13px] leading-5 text-muted-foreground">
                to {formatUnknownTime(workOrder.properties.scheduledEnd)}
              </span>
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15.5px] leading-5 font-semibold tracking-[-0.01em] group-hover:text-primary">
                {workOrder.properties.title}
              </span>
              <span className="truncate text-[13.5px] leading-5 text-muted-foreground">
                <span className="tabular-nums">{workOrder.properties.number}</span> ·{" "}
                {workOrder.links.equipment?.properties.name ?? "Equipment"} ·{" "}
                {workOrder.links.assignee?.properties.name ?? "Unassigned"}
              </span>
              <span className="pt-1 sm:hidden">
                <StatusBadge value={workOrder.properties.status} />
              </span>
            </span>
            <span className="max-sm:hidden">
              <StatusBadge value={workOrder.properties.status} />
            </span>
            <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground max-sm:hidden" />
          </Link>
        </li>
      ))}
    </ul>
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
    minWidth: timelineTechnicianColumnWidth + timelineWidth,
  } satisfies CSSProperties
  const timelineGridStyle = {
    gridTemplateColumns: `${timelineTechnicianColumnWidth}px minmax(${timelineWidth}px, 1fr)`,
  } satisfies CSSProperties

  return (
    <>
      <div
        className="overflow-x-auto overscroll-x-contain border-t border-border/70 [scrollbar-gutter:stable] focus-visible:outline-none"
        role="region"
        aria-label="Technician schedule timeline"
        tabIndex={0}
      >
        <div className="w-full" style={timelineCanvasStyle}>
          <div className="grid border-b border-border/70" style={timelineGridStyle}>
            <div className="flex items-center border-r border-border/70 bg-card px-5 text-[12px] font-medium text-muted-foreground md:sticky md:left-0 md:z-30">
              Technician
            </div>
            <div className="relative h-10">
              {range.hours.map((hour) => (
                <span
                  key={hour}
                  className="absolute top-1/2 text-[12px] whitespace-nowrap text-muted-foreground tabular-nums"
                  style={timeLabelStyle(hour, range)}
                >
                  {formatHour(hour)}
                </span>
              ))}
              {nowPosition !== undefined ? (
                <span
                  className="absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-primary-foreground tabular-nums"
                  style={{ left: `${nowPosition}%` }}
                >
                  {formatTime(now)}
                </span>
              ) : null}
            </div>
          </div>

          {technicians.length === 0 ? (
            <p className="px-6 py-10 text-[14px] text-muted-foreground">
              No technicians match this view.
            </p>
          ) : null}

          {technicians.map((technician) => {
            const assignedWork = workOrders.filter(
              (workOrder) => workOrder.links.assignee?.primaryId === technician.primaryId
            )
            const availabilityStart = recommendedAvailabilityStart(technician, pending, date, now)
            return (
              <div
                key={technician.primaryId}
                className="grid border-b border-border/70 last:border-b-0"
                style={timelineGridStyle}
              >
                <Link
                  to={`/technicians/${encodeURIComponent(technician.primaryId)}`}
                  className="group flex items-center gap-3 border-r border-border/70 bg-card px-5 py-3 transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_3%,var(--card))] focus-visible:bg-[color-mix(in_srgb,var(--foreground)_4%,var(--card))] focus-visible:outline-none md:sticky md:left-0 md:z-20"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-[12px] font-semibold text-foreground/75">
                    {initials(technician.properties.name)}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[14.5px] leading-5 font-semibold group-hover:text-primary">
                      {technician.properties.name}
                    </span>
                    <span className="truncate text-[12.5px] leading-4 text-muted-foreground">
                      {humanize(technician.properties.territory)} ·{" "}
                      {humanize(technician.properties.certification)}
                    </span>
                    <StatusIndicator
                      value={technician.properties.availability}
                      className="text-[12.5px] leading-4"
                    />
                  </span>
                </Link>

                <div className="relative min-h-[80px] overflow-hidden">
                  <TimelineGuides range={range} />
                  {availabilityStart && assignedWork.length === 0 ? (
                    <div
                      className="absolute inset-y-3 flex items-center overflow-hidden rounded-[12px] border border-dashed border-[color:var(--success)]/45 bg-[color-mix(in_srgb,var(--success)_5%,var(--card))] px-3"
                      style={availabilityStyle(availabilityStart, date, range)}
                    >
                      <span className="truncate text-[12.5px] font-medium text-[color:var(--success)]">
                        Available from {formatTime(availabilityStart)}
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
                      className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary"
                      style={{ left: `${nowPosition}%` }}
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/70 px-6 py-4 text-[12.5px] text-muted-foreground">
        <LegendSwatch tone="primary" label="On site or scheduled" />
        <LegendSwatch tone="info" label="Dispatched" />
        <LegendSwatch tone="warning" label="Paused" />
        <span className="inline-flex items-center gap-2">
          <span className="size-3 rounded-[4px] border border-dashed border-[color:var(--success)]/60" />
          Available
        </span>
      </div>
    </>
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
  const tone = blockTones[scheduleTone(workOrder.properties.status)]

  return (
    <Link
      to={href}
      title={`${workOrder.properties.number} · ${workOrder.properties.title}`}
      className={cn(
        "absolute inset-y-3 z-[5] flex min-w-[120px] flex-col justify-center gap-0.5 overflow-hidden rounded-[12px] px-3 transition-shadow hover:shadow-[var(--shadow-raised)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        tone.block
      )}
      style={style}
    >
      <span className="truncate text-[13px] leading-4 font-semibold text-foreground">
        {workOrder.links.equipment?.properties.name ?? "Equipment"}
      </span>
      <span className={cn("truncate text-[12px] leading-4 font-medium tabular-nums", tone.text)}>
        {workOrder.properties.number} · {humanize(workOrder.properties.status)}
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
          className="pointer-events-none absolute inset-y-0 w-px bg-border/60"
          style={{ left: `${hourPosition(hour, range)}%` }}
          aria-hidden="true"
        />
      ))}
    </>
  )
}

function LegendSwatch({ tone, label }: { tone: BlockTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("size-3 rounded-[4px]", blockTones[tone].block)} />
      {label}
    </span>
  )
}

type BlockTone = "primary" | "info" | "warning"

const blockTones: Record<BlockTone, { block: string; text: string }> = {
  primary: {
    block:
      "bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_24%,transparent)]",
    text: "text-primary",
  },
  info: {
    block:
      "bg-[color-mix(in_srgb,var(--info)_11%,var(--card))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--info)_24%,transparent)]",
    text: "text-[color:var(--info)]",
  },
  warning: {
    block:
      "bg-[color-mix(in_srgb,var(--warning)_12%,var(--card))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warning)_26%,transparent)]",
    text: "text-[color:var(--warning)]",
  },
}

function scheduleTone(status: string): BlockTone {
  if (status === "paused") return "warning"
  if (status === "dispatched" || status === "en_route") return "info"
  return "primary"
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

function createTimelineRange(date: Date, workOrders: WorkOrderRow[]): TimelineRange {
  let startMinutes = timelineStartHour * 60
  let endMinutes = timelineEndHour * 60

  for (const workOrder of workOrders) {
    const scheduledStart = minutesFromDayStart(workOrder.properties.scheduledStart, date)
    const scheduledEnd = minutesFromDayStart(workOrder.properties.scheduledEnd, date)
    if (scheduledStart !== undefined) {
      startMinutes = Math.min(
        startMinutes,
        Math.floor(scheduledStart / timelineSnapMinutes) * timelineSnapMinutes
      )
      endMinutes = Math.max(
        endMinutes,
        Math.ceil((scheduledStart + timelineDefaultWorkDurationMinutes) / timelineSnapMinutes) *
          timelineSnapMinutes
      )
    }
    if (scheduledEnd !== undefined) {
      endMinutes = Math.max(
        endMinutes,
        Math.ceil(scheduledEnd / timelineSnapMinutes) * timelineSnapMinutes
      )
    }
  }

  startMinutes = Math.max(0, startMinutes)
  endMinutes = Math.min(24 * 60, endMinutes)
  const hours: number[] = []
  for (let minutes = startMinutes; minutes <= endMinutes; minutes += 60) {
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
  if (position === 0) return { left: 12, transform: "translateY(-50%)" }
  if (position === 100) return { right: 12, transform: "translateY(-50%)" }
  return { left: `${position}%`, transform: "translate(-50%, -50%)" }
}

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2026, 0, 1, hour))
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

function durationLabel(start: unknown, end: unknown): string | undefined {
  if (typeof start !== "string" && !(start instanceof Date)) return undefined
  if (typeof end !== "string" && !(end instanceof Date)) return undefined
  const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000)
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${minutes} min on site`
  return rest === 0 ? `${hours} h on site` : `${hours} h ${rest} min on site`
}

function formatScheduleHeading(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date)
}

function count(value: number, noun: string): string {
  return `${value} ${value === 1 ? noun : `${noun}s`}`
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
