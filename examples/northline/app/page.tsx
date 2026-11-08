import { Composer, useAgentConversation, useCurrentUser } from "@sixb/app"
import { useObjectsCount, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { useNavigate } from "react-router-dom"
import { BuildingAlarm } from "../ontology/building-alarm"
import { ServiceCase } from "../ontology/service-case"
import { WorkOrder } from "../ontology/work-order"
import { Widget, WidgetMetric, WidgetState } from "./_components/home/widget"
import { NorthlineMark } from "./_components/northline-mark"
import { formatTime } from "./_components/ui"
import { threadPath } from "./_lib/agent-threads"
import {
  type CaseView,
  caseClock,
  casePriority,
  inCaseView,
  openServiceCases,
  openWorkOrders,
  useCasesWithFieldWorkDone,
} from "./_lib/service-cases"

const casesQuery = openServiceCases.orderBy(ServiceCase.p.responseDeadline, "asc").limit(100)

const workOrdersQuery = openWorkOrders.orderBy(WorkOrder.p.scheduledStart, "asc").limit(100)

const activeAlarms = objects(BuildingAlarm)
  .query()
  .where((alarm) => alarm.p.status.eq("active"))

/** Home: the Northline mark and the composer, with a few glanceable numbers under it. */
export default function NorthlineHomePage() {
  const navigate = useNavigate()
  const user = useCurrentUser()
  const conversation = useAgentConversation({
    threadId: null,
    onThreadCreated: (threadId) => navigate(threadPath(threadId)),
  })
  const cases = useObjectsQuery(casesQuery, { staleTime: 30_000 })
  const workOrders = useObjectsQuery(workOrdersQuery, { staleTime: 30_000 })
  const fieldWorkDone = useCasesWithFieldWorkDone()
  const alarmCount = useObjectsCount(activeAlarms)

  const open = cases.data?.objects ?? []
  // The same cases, in the same order, as the list views the tiles open.
  const inView = (view: CaseView) =>
    open
      .filter((item) => inCaseView(item, view, fieldWorkDone))
      .sort((left, right) => casePriority(right.properties) - casePriority(left.properties))
  const needsYou = inView("action")
  const atRisk = inView("risk")
  const dueNext = open
    .map((item) => ({ item, dueAt: caseClock(item.properties).dueAt }))
    .filter((entry) => Number.isFinite(entry.dueAt))
    .sort((left, right) => left.dueAt - right.dueAt)[0]?.item

  const todaysWork = (workOrders.data?.objects ?? []).filter((item) =>
    isToday(item.properties.scheduledStart)
  )
  const onSite = todaysWork.filter((item) => item.properties.status === "on_site").length
  const nextJob = todaysWork.find((item) => item.properties.status !== "on_site")

  return (
    <div className="nl-home mx-auto flex w-full max-w-[46rem] flex-col md:pt-[16vh] md:pb-12">
      <header className="nl-home-brand nl-home-rise flex flex-col items-center text-center">
        <NorthlineMark className="size-14" />
        <h1 className="mt-4 text-[30px] leading-tight font-semibold tracking-[-0.025em]">
          {greeting()}
          {user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}
        </h1>
        <p className="mt-1 text-[14px] text-muted-foreground">
          Northline Operations · {todayLabel()}
        </p>
      </header>

      <Composer
        {...conversation.composerProps}
        className="nl-home-composer nl-home-rise md:mt-8 bg-transparent px-0 pt-0 pb-0 [--rise-delay:60ms]"
      />

      <section
        aria-label="Today at a glance"
        className="nl-home-tiles mt-6 grid md:mt-5 grid-cols-2 gap-3 sm:grid-cols-4"
      >
        <Widget to="/service-cases?view=action" label="View cases that need you" title="Needs you">
          <WidgetState loading={cases.isLoading} error={cases.isError} label="cases">
            <WidgetMetric
              value={needsYou.length}
              detail={needsYou.length > 0 ? "waiting on a decision" : "All clear"}
            />
          </WidgetState>
        </Widget>

        <Widget to="/service-cases?view=risk" label="View cases at risk" title="At risk">
          <WidgetState loading={cases.isLoading} error={cases.isError} label="deadlines">
            <WidgetMetric
              value={atRisk.length}
              valueClassName={atRisk.length > 0 ? "text-[color:var(--warning)]" : ""}
              detail={dueNext ? `Next: ${dueNext.properties.number}` : "Nothing due"}
            />
          </WidgetState>
        </Widget>

        <Widget to="/dispatch" label="View today’s schedule" title="Today">
          <WidgetState loading={workOrders.isLoading} error={workOrders.isError} label="jobs">
            <WidgetMetric
              value={todaysWork.length}
              detail={
                onSite > 0
                  ? `${onSite} on site`
                  : nextJob
                    ? `Next ${formatTime(nextJob.properties.scheduledStart)}`
                    : "No jobs"
              }
            />
          </WidgetState>
        </Widget>

        <Widget to="/equipment" label="View equipment" title="Alarms">
          <WidgetState loading={alarmCount.isLoading} error={alarmCount.isError} label="alarms">
            <WidgetMetric
              value={alarmCount.data ?? 0}
              valueClassName={alarmCount.data ? "text-destructive" : ""}
              detail="active"
            />
          </WidgetState>
        </Widget>
      </section>
    </div>
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
