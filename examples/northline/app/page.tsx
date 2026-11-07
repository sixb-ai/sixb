import { Composer, useAgentConversation, useCurrentUser } from "@sixb/app"
import { useObjectsCount, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { Fragment, type ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { BuildingAlarm } from "../ontology/building-alarm"
import { Equipment } from "../ontology/equipment"
import { Quote } from "../ontology/quote"
import { ServiceCase } from "../ontology/service-case"
import { Technician } from "../ontology/technician"
import { WorkOrder } from "../ontology/work-order"
import { EquipmentPicture } from "./_components/equipment-picture"
import { Widget, WidgetBreakdown, WidgetMetric, WidgetState } from "./_components/home/widget"
import {
  CaseClockText,
  formatMoney,
  formatRelativeTime,
  formatTime,
  humanize,
  initials,
  StatusBadge,
} from "./_components/ui"
import { threadPath } from "./_lib/agent-threads"
import type { QueryRow } from "./_lib/query-types"
import {
  type CaseView,
  caseClock,
  caseDecision,
  casePriority,
  inCaseView,
  openServiceCases,
  openWorkOrders,
  useCasesWithFieldWorkDone,
} from "./_lib/service-cases"

const casesQuery = openServiceCases
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.equipment)
  .orderBy(ServiceCase.p.responseDeadline, "asc")
  .limit(100)

const equipmentQuery = objects(Equipment).query().limit(200)

const quotesQuery = objects(Quote).query().limit(100)

const workOrdersQuery = openWorkOrders
  .expand(WorkOrder.l.assignee)
  .orderBy(WorkOrder.p.scheduledStart, "asc")
  .limit(100)

const alarmsQuery = objects(BuildingAlarm)
  .query()
  .expand(BuildingAlarm.l.equipment)
  .orderBy(BuildingAlarm.p.observedAt, "desc")
  .limit(1)

// Widget headers count every record, past the rows a widget loads.
const allCases = objects(ServiceCase).query()
const allQuotes = objects(Quote).query()
const activeAlarms = objects(BuildingAlarm)
  .query()
  .where((alarm) => alarm.p.status.eq("active"))

const techniciansQuery = objects(Technician).query().orderBy(Technician.p.name, "asc").limit(50)

type CaseRow = QueryRow<typeof casesQuery>
type AlarmRow = QueryRow<typeof alarmsQuery>

const summaryLink = "font-semibold whitespace-nowrap hover:underline"

export default function NorthlineHomePage() {
  const navigate = useNavigate()
  const user = useCurrentUser()
  const conversation = useAgentConversation({
    threadId: null,
    onThreadCreated: (threadId) => navigate(threadPath(threadId)),
  })
  const cases = useObjectsQuery(casesQuery, { staleTime: 30_000 })
  const equipment = useObjectsQuery(equipmentQuery, { staleTime: 30_000 })
  const quotes = useObjectsQuery(quotesQuery, { staleTime: 30_000 })
  const workOrders = useObjectsQuery(workOrdersQuery, { staleTime: 30_000 })
  const fieldWorkDone = useCasesWithFieldWorkDone()
  const alarms = useObjectsQuery(alarmsQuery, { staleTime: 30_000 })
  const technicians = useObjectsQuery(techniciansQuery, { staleTime: 30_000 })
  const caseTotal = useObjectsCount(allCases)
  const quoteTotal = useObjectsCount(allQuotes)
  const activeAlarmCount = useObjectsCount(activeAlarms)

  const open = cases.data?.objects ?? []
  const countStatus = (...statuses: string[]) =>
    open.filter((item) => statuses.includes(item.properties.status ?? "")).length
  // Before a technician is on site: new, being triaged, or dispatched and on the way.
  const beforeArrival = countStatus("new", "triage", "dispatching")
  // The same cases, in the same order, as the list views the summary links to.
  const inView = (view: CaseView) =>
    open
      .filter((item) => inCaseView(item, view, fieldWorkDone))
      .sort((left, right) => casePriority(right.properties) - casePriority(left.properties))
  const atRisk = inView("risk")
  const decisionRows = inView("action")
  // The commitments still running, soonest first: responses, then resolutions once on site.
  const dueNext = open
    .map((item) => ({ item, dueAt: caseClock(item.properties).dueAt }))
    .filter((entry) => Number.isFinite(entry.dueAt))
    .sort((left, right) => left.dueAt - right.dueAt)
    .map((entry) => entry.item)

  const quoteRows = quotes.data?.objects ?? []
  const quoteCount = (...statuses: string[]) =>
    quoteRows.filter((item) => statuses.includes(item.properties.status ?? "")).length
  const sentQuotes = quoteRows.filter((item) => item.properties.status === "sent")
  const sentTotal = sentQuotes.reduce((total, item) => total + (item.properties.amount ?? 0), 0)

  const units = equipment.data?.objects ?? []
  const unitCount = (health: string) =>
    units.filter((item) => item.properties.health === health).length
  const healthy = unitCount("healthy")

  // The same jobs Dispatch schedules today: everything not finished, on-site work first.
  const todaysWork = (workOrders.data?.objects ?? [])
    .filter((item) => isToday(item.properties.scheduledStart))
    .sort(
      (left, right) =>
        Number(right.properties.status === "on_site") - Number(left.properties.status === "on_site")
    )

  const crew = (technicians.data?.objects ?? []).filter(
    (item) => item.properties.availability !== "off_duty"
  )
  const available = crew.filter((item) => item.properties.availability === "available")

  return (
    <div className="mx-auto w-full max-w-[68rem] pb-12">
      <header>
        <p className="text-[13px] font-medium text-muted-foreground">{todayLabel()}</p>
        <h1 className="mt-1 text-[32px] leading-tight font-bold tracking-[-0.025em]">
          {greeting()}
          {user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}
        </h1>
        <p className="mt-2 min-h-6 max-w-3xl text-[15px] leading-normal text-pretty text-muted-foreground">
          {!cases.data || quotes.isLoading ? null : (
            <Summary
              parts={[
                decisionRows.length > 0 ? (
                  <Link
                    key="action"
                    className={cn(summaryLink, "text-foreground")}
                    to="/service-cases?view=action"
                  >
                    {decisionRows.length} {decisionRows.length === 1 ? "case needs" : "cases need"}{" "}
                    you
                  </Link>
                ) : null,
                atRisk.length > 0 ? (
                  <Link
                    key="risk"
                    className={cn(summaryLink, "text-[color:var(--warning)]")}
                    to="/service-cases?view=risk"
                  >
                    {atRisk.length} {atRisk.length === 1 ? "case is" : "cases are"} at risk
                  </Link>
                ) : null,
                quotes.data && sentQuotes.length > 0 ? (
                  <Fragment key="quotes">
                    <Link className={cn(summaryLink, "text-foreground")} to="/quotes">
                      {sentQuotes.length} {sentQuotes.length === 1 ? "quote is" : "quotes are"}
                    </Link>{" "}
                    waiting on customers
                  </Fragment>
                ) : null,
              ]}
            />
          )}
        </p>
      </header>

      {/* Pinned while widgets scroll under it; the fade hides their edges above the glass. */}
      <div className="sticky top-3 z-30 mt-6 before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:-z-10 before:h-12 before:bg-gradient-to-b before:from-background before:from-40% before:to-transparent sm:top-4">
        <Composer
          {...conversation.composerProps}
          placeholder="Ask about today’s work"
          className="nl-home-composer bg-transparent px-0 pt-0 pb-0"
        />
      </div>

      <section aria-label="Operations overview" className="@container mt-8">
        <div className="nl-widget-grid grid auto-rows-[minmax(13rem,auto)] grid-cols-2 gap-4 @4xl:grid-cols-4">
          <Widget
            to="/service-cases"
            label="View service cases"
            title="Service cases"
            size="medium"
            meta={caseTotal.data === undefined ? null : `${caseTotal.data} total`}
          >
            <WidgetState loading={cases.isLoading} error={cases.isError} label="service cases">
              <div className="mt-auto pt-4">
                <WidgetMetric
                  value={open.length}
                  label="open"
                  aside={`${inView("field").length} in the field`}
                />
                <WidgetBreakdown
                  label="Open cases by stage"
                  segments={[
                    {
                      key: "dispatch",
                      label: "Dispatch",
                      count: beforeArrival,
                      className: "bg-primary",
                    },
                    {
                      key: "in_service",
                      label: "In service",
                      count: countStatus("in_service"),
                      className: "bg-[color:var(--northline-air)]",
                    },
                    {
                      key: "authorization",
                      label: "Authorization",
                      count: countStatus("awaiting_authorization"),
                      className: "bg-slate-500 dark:bg-slate-400",
                    },
                    {
                      key: "resolved",
                      label: "To close",
                      count: countStatus("resolved"),
                      className: "bg-slate-300 dark:bg-slate-600",
                    },
                  ]}
                />
              </div>
            </WidgetState>
          </Widget>

          <Widget
            to="/service-cases?view=risk"
            label="View cases at risk"
            title="Due next"
            size="small"
          >
            <WidgetState loading={cases.isLoading} error={cases.isError} label="deadlines">
              <div className="mt-auto flex flex-col gap-3 pt-4">
                <WidgetMetric
                  value={atRisk.length}
                  label="at risk"
                  valueClassName={atRisk.length > 0 ? "text-[color:var(--warning)]" : ""}
                />
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {dueNext.slice(0, 2).map((item) => (
                    <li key={item.primaryId} className="flex justify-between gap-2">
                      <span className="truncate text-foreground/80">{item.properties.number}</span>
                      <CaseClockText
                        serviceCase={item.properties}
                        className="shrink-0 font-medium"
                      />
                    </li>
                  ))}
                  {dueNext.length === 0 ? (
                    <li className="text-muted-foreground">Nothing is due</li>
                  ) : null}
                </ul>
              </div>
            </WidgetState>
          </Widget>

          <Widget to="/technicians" label="View technicians" title="Crew" size="small">
            <WidgetState
              loading={technicians.isLoading}
              error={technicians.isError}
              label="the crew"
            >
              <div className="mt-auto flex flex-col gap-3 pt-4">
                <WidgetMetric value={available.length} label="available" />
                <div className="flex items-center justify-between gap-2">
                  <div className="flex -space-x-2">
                    {crew.slice(0, 5).map((item) => (
                      <span
                        key={item.primaryId}
                        title={item.properties.name}
                        className={cn(
                          "flex size-8 items-center justify-center rounded-full border-2 border-card text-[11px] font-semibold",
                          item.properties.availability === "available"
                            ? "bg-[color:var(--northline-tint)] text-primary"
                            : "bg-muted text-foreground/60"
                        )}
                      >
                        {initials(item.properties.name)}
                      </span>
                    ))}
                  </div>
                  <span className="text-[13px] text-muted-foreground">{crew.length} on duty</span>
                </div>
              </div>
            </WidgetState>
          </Widget>

          <AlarmWidget
            loading={alarms.isLoading}
            error={alarms.isError}
            alarm={alarms.data?.objects[0]}
            active={activeAlarmCount.data}
          />

          <Widget
            to="/service-cases?view=action"
            label="View cases waiting on a decision"
            title="Needs you"
            size="medium"
            meta={cases.data ? `${decisionRows.length} waiting` : null}
          >
            <WidgetState loading={cases.isLoading} error={cases.isError} label="decisions">
              {decisionRows.length === 0 ? (
                <p className="mt-auto pt-4 text-[14px] text-muted-foreground">
                  Nothing is waiting on a decision.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col">
                  {decisionRows.slice(0, 3).map((item) => (
                    <DecisionRow
                      key={item.primaryId}
                      item={item}
                      decision={caseDecision(
                        item.properties.status,
                        fieldWorkDone.has(item.primaryId)
                      )}
                    />
                  ))}
                </ul>
              )}
            </WidgetState>
          </Widget>

          <Widget
            to="/dispatch"
            label="View today’s schedule"
            title="Today’s schedule"
            size="medium"
            meta={workOrders.data ? `${todaysWork.length} jobs` : null}
          >
            <WidgetState loading={workOrders.isLoading} error={workOrders.isError} label="jobs">
              {todaysWork.length === 0 ? (
                <p className="mt-auto pt-4 text-[14px] text-muted-foreground">
                  Nothing is scheduled today.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col">
                  {todaysWork.slice(0, 3).map((job) => (
                    <li
                      key={job.primaryId}
                      className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-baseline gap-3 border-t border-border/70 py-2.5 first:border-t-0"
                    >
                      <span
                        className={cn(
                          "text-[14px] font-semibold tabular-nums",
                          job.properties.status === "on_site" && "text-primary"
                        )}
                      >
                        {job.properties.status === "on_site"
                          ? "Now"
                          : formatTime(job.properties.scheduledStart)}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[14.5px] font-medium">
                          {job.properties.title}
                        </span>
                        <span className="truncate text-[12.5px] text-muted-foreground">
                          {job.links.assignee?.properties.name ?? "Unassigned"} ·{" "}
                          {humanize(job.properties.status)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </WidgetState>
          </Widget>

          <Widget
            to="/quotes"
            label="View quotes"
            title="Quotes"
            size="medium"
            meta={quoteTotal.data === undefined ? null : `${quoteTotal.data} total`}
          >
            <WidgetState loading={quotes.isLoading} error={quotes.isError} label="quotes">
              <div className="mt-auto pt-4">
                <WidgetMetric
                  value={formatMoney(sentTotal)}
                  label="with customers"
                  aside={`${quoteCount("draft", "internal_review")} in review`}
                />
                <WidgetBreakdown
                  label="Quotes by status"
                  segments={[
                    {
                      key: "draft",
                      label: "In review",
                      count: quoteCount("draft", "internal_review"),
                      className: "bg-slate-300 dark:bg-slate-600",
                    },
                    {
                      key: "sent",
                      label: "Sent",
                      count: quoteCount("sent"),
                      className: "bg-[color:var(--northline-air)]",
                    },
                    {
                      key: "approved",
                      label: "Approved",
                      count: quoteCount("approved"),
                      className: "bg-primary",
                    },
                    {
                      key: "declined",
                      label: "Declined",
                      count: quoteCount("declined", "expired"),
                      className: "bg-slate-500 dark:bg-slate-400",
                    },
                  ]}
                />
              </div>
            </WidgetState>
          </Widget>

          <Widget
            to="/equipment"
            label="View equipment"
            title="Equipment"
            size="medium"
            meta={equipment.data ? `${units.length} units` : null}
          >
            <WidgetState loading={equipment.isLoading} error={equipment.isError} label="equipment">
              <div className="mt-auto pt-4">
                <WidgetMetric
                  value={units.length ? `${Math.round((healthy / units.length) * 100)}%` : "—"}
                  label="healthy"
                  aside={`${units.length - healthy} need attention`}
                />
                <WidgetBreakdown
                  label="Equipment by condition"
                  segments={[
                    {
                      key: "healthy",
                      label: "Healthy",
                      count: healthy,
                      className: "bg-[color:var(--success)]",
                    },
                    {
                      key: "watch",
                      label: "Watch",
                      count: unitCount("watch"),
                      className: "bg-[color:var(--warning)]",
                    },
                    {
                      key: "unhealthy",
                      label: "Unhealthy",
                      count: unitCount("unhealthy"),
                      className: "bg-destructive",
                    },
                    {
                      key: "offline",
                      label: "Offline",
                      count: unitCount("offline"),
                      className: "bg-slate-400",
                    },
                  ]}
                />
              </div>
            </WidgetState>
          </Widget>
        </div>
      </section>
    </div>
  )
}

/** The newest alarm as the panel's one picture: the unit it came from, and what it said. */
function AlarmWidget({
  loading,
  error,
  alarm,
  active,
}: {
  loading: boolean
  error: boolean
  alarm: AlarmRow | undefined
  active: number | undefined
}) {
  const equipment = alarm?.links.equipment
  return (
    <Widget
      to={equipment ? `/equipment/${encodeURIComponent(equipment.primaryId)}` : "/equipment"}
      label="View the latest alarm"
      title="Latest alarm"
      size="large"
      meta={active === undefined ? null : `${active} active`}
      className="pb-0"
    >
      <WidgetState loading={loading} error={error} label="alarms">
        {alarm ? (
          <div className="-mx-[22px] mt-4 flex flex-1 flex-col">
            <div className="relative flex min-h-48 flex-1 items-center justify-center bg-muted">
              <EquipmentPicture
                name={equipment?.properties.name}
                type={equipment?.properties.equipmentType}
                inset="p-6"
                className="absolute inset-0"
                iconClassName="size-14 text-foreground/30"
              />
              <span className="absolute top-3 left-[22px]">
                <StatusBadge value={alarm.properties.severity} />
              </span>
            </div>
            <div className="flex flex-col gap-1 px-[22px] pt-4 pb-5">
              <span className="text-[18px] leading-6 font-semibold tracking-[-0.015em] text-pretty">
                {alarm.properties.message}
              </span>
              <span className="text-[13.5px] text-muted-foreground">
                {equipment?.properties.name ?? "Equipment"} ·{" "}
                {formatRelativeTime(alarm.properties.observedAt)}
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-auto pt-4 pb-5 text-[14px] text-muted-foreground">No recent alarms.</p>
        )}
      </WidgetState>
    </Widget>
  )
}

function DecisionRow({ item, decision }: { item: CaseRow; decision: string | undefined }) {
  return (
    <li className="flex items-center gap-3 border-t border-border/70 py-2.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14.5px] font-medium">
          {item.properties.number} · {item.properties.title}
        </span>
        <span className="truncate text-[12.5px] text-muted-foreground">
          {item.links.customer?.properties.name ?? "Customer"} ·{" "}
          <CaseClockText serviceCase={item.properties} />
        </span>
      </span>
      <Link
        to={`/service-cases/${encodeURIComponent(item.primaryId)}`}
        className={cn(
          "relative z-20 inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-[13px] font-semibold transition-colors",
          item.properties.status === "triage"
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-black/[0.05] text-foreground hover:bg-black/[0.08] dark:bg-white/[0.08]"
        )}
      >
        {decision}
      </Link>
    </li>
  )
}

/** Joins what needs attention into one sentence, or says nothing does. */
function Summary({ parts }: { parts: ReadonlyArray<ReactNode | null> }) {
  const present = parts
    .map((part, position) => ({ part, position }))
    .filter((entry) => entry.part !== null)
  if (present.length === 0) return <>Nothing needs your attention right now.</>
  return (
    <>
      {present.map((entry, index) => (
        <Fragment key={entry.position}>
          {index === 0
            ? ""
            : index === present.length - 1
              ? present.length > 2
                ? ", and "
                : " and "
              : ", "}
          {entry.part}
        </Fragment>
      ))}
      .
    </>
  )
}

function isToday(value: string | Date | undefined): boolean {
  if (!value) return false
  return new Date(value).toDateString() === new Date().toDateString()
}

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

function todayLabel(): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date())
}
