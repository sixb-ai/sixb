import { Composer, useAgentConversation, useCurrentUser } from "@sixb/app"
import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowUpRight, BellRing, ChevronRight } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { Link, useNavigate } from "react-router-dom"
import { BuildingAlarm } from "../ontology/building-alarm"
import { Equipment } from "../ontology/equipment"
import { Quote } from "../ontology/quote"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"
import {
  deadlineLabel,
  formatMoney,
  formatRelativeTime,
  formatTime,
  Section,
  StatTile,
  StatusBadge,
  StatusIndicator,
} from "./_components/ui"
import { threadPath } from "./_lib/agent-threads"

const casesQuery = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .orderBy(ServiceCase.p.responseDeadline, "asc")
  .limit(100)

const equipmentQuery = objects(Equipment).query().expand(Equipment.l.facility).limit(100)

const quotesQuery = objects(Quote).query().expand(Quote.l.customer).limit(100)

const visitsQuery = objects(ServiceVisit)
  .query()
  .expand(ServiceVisit.l.workOrder)
  .expand(ServiceVisit.l.technician)
  .orderBy(ServiceVisit.p.scheduledStart, "asc")
  .limit(100)

const alarmsQuery = objects(BuildingAlarm)
  .query()
  .expand(BuildingAlarm.l.equipment)
  .orderBy(BuildingAlarm.p.observedAt, "desc")
  .limit(6)

type CaseRow = NonNullable<Awaited<ReturnType<typeof casesQuery.first>>>

const decisions: Record<string, { label: string; action: string }> = {
  new: { label: "Acknowledge", action: "Acknowledge" },
  triage: { label: "Dispatch", action: "Review dispatch" },
  awaiting_authorization: { label: "Repair quote", action: "Review quote" },
  resolved: { label: "Ready to close", action: "Close case" },
}

const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const suggestions = [
  "What needs dispatch right now?",
  "Which equipment is trending unhealthy?",
  "Summarize SC-1042 for the customer",
]

export default function NorthlineHomePage() {
  const navigate = useNavigate()
  const user = useCurrentUser()
  const conversation = useAgentConversation({
    threadId: null,
    onThreadCreated: (threadId) => navigate(threadPath(threadId)),
  })
  const cases = useObjectsQuery(casesQuery)
  const equipment = useObjectsQuery(equipmentQuery)
  const quotes = useObjectsQuery(quotesQuery)
  const visits = useObjectsQuery(visitsQuery)
  const alarms = useObjectsQuery(alarmsQuery)

  const caseRows = cases.data?.objects ?? []
  const openCases = caseRows.filter(
    (item) => !["closed", "cancelled"].includes(item.properties.status ?? "")
  )
  const atRisk = openCases.filter((item) =>
    ["at_risk", "breached"].includes(item.properties.slaStatus ?? "")
  )
  const needsDispatch = openCases.filter((item) => item.properties.status === "triage")
  const nextDeadline = openCases.find(
    (item) => new Date(item.properties.responseDeadline).getTime() > Date.now()
  )
  const equipmentRows = equipment.data?.objects ?? []
  const watchedEquipment = equipmentRows
    .filter((item) => ["unhealthy", "watch", "offline"].includes(item.properties.health ?? ""))
    .sort((left, right) => healthRank(left.properties.health) - healthRank(right.properties.health))
  const unhealthyCount = watchedEquipment.filter(
    (item) => item.properties.health !== "watch"
  ).length
  const sentQuotes = (quotes.data?.objects ?? []).filter(
    (item) => item.properties.status === "sent"
  )
  const sentTotal = sentQuotes.reduce((total, item) => total + item.properties.amount, 0)

  const decisionRows = useMemo(
    () =>
      openCases
        .filter((item) => item.properties.status in decisions)
        .sort(
          (left, right) =>
            (severityRank[left.properties.severity] ?? 9) -
              (severityRank[right.properties.severity] ?? 9) ||
            new Date(left.properties.responseDeadline).getTime() -
              new Date(right.properties.responseDeadline).getTime()
        )
        .slice(0, 5),
    [openCases]
  )

  const scheduleRows = (visits.data?.objects ?? [])
    .filter((item) => {
      if (item.properties.status === "in_progress") return true
      if (item.properties.status !== "scheduled") return false
      return isToday(item.properties.scheduledStart)
    })
    .slice(0, 5)

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col items-center gap-6 pt-4 pb-2 text-center md:pt-10">
        <div className="flex flex-col gap-2">
          <p className="text-[15px] font-medium text-muted-foreground">{todayLabel()}</p>
          <h1 className="text-[38px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[46px]">
            {greeting()}
            {user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}
          </h1>
        </div>
        <div className="w-full max-w-[46rem] text-left">
          <Composer
            {...conversation.composerProps}
            placeholder="Ask about today’s work"
            className="bg-transparent px-0 pt-0 pb-0"
          />
        </div>
        <div className="flex max-w-3xl flex-wrap justify-center gap-2">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => conversation.composerProps.onSend(text, [], [])}
              className="h-9 rounded-full bg-black/[0.045] px-4 text-[14px] font-medium text-foreground/85 transition-colors hover:bg-black/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:bg-white/[0.07] dark:hover:bg-white/[0.1]"
            >
              {text}
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))] gap-4">
        <StatTile
          label="Open cases"
          value={cases.isLoading ? "—" : openCases.length}
          detail={
            needsDispatch.length > 0
              ? `${needsDispatch.length} waiting on dispatch`
              : "All assigned"
          }
        />
        <StatTile
          label="Response at risk"
          value={cases.isLoading ? "—" : atRisk.length}
          detail={
            nextDeadline
              ? `Next deadline ${deadlineLabel(nextDeadline.properties.responseDeadline)}`
              : "No open deadlines"
          }
          tone={atRisk.length > 0 ? "warning" : undefined}
        />
        <StatTile
          label="Equipment to watch"
          value={equipment.isLoading ? "—" : watchedEquipment.length}
          detail={
            unhealthyCount > 0 ? `${unhealthyCount} unhealthy or offline` : "Nothing unhealthy"
          }
          tone={unhealthyCount > 0 ? "critical" : undefined}
        />
        <StatTile
          label="Quotes with customers"
          value={quotes.isLoading ? "—" : formatMoney(sentTotal)}
          detail={`${sentQuotes.length} waiting on approval`}
        />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Section
          title="Needs you"
          action={<span className="text-muted-foreground">{decisionRows.length} open</span>}
        >
          {decisionRows.length === 0 ? (
            <Empty>Nothing is waiting on a decision.</Empty>
          ) : (
            <ul className="px-6 pb-2">
              {decisionRows.map((item) => (
                <DecisionRow key={item.primaryId} item={item} />
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="On the schedule"
          action={
            <Link to="/dispatch" className="font-medium text-primary hover:underline">
              Dispatch
            </Link>
          }
        >
          {scheduleRows.length === 0 ? (
            <Empty>No visits today.</Empty>
          ) : (
            <ul className="px-6 pb-2">
              {scheduleRows.map((visit) => (
                <li
                  key={visit.primaryId}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-4 border-t border-border/70 py-3.5 first:border-t-0"
                >
                  <span className="text-[14px] font-semibold tabular-nums">
                    {visit.properties.status === "in_progress"
                      ? "Now"
                      : formatTime(visit.properties.scheduledStart)}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-medium">
                      {visit.links.workOrder?.properties.title ?? visit.properties.number}
                    </span>
                    <span className="truncate text-[13px] text-muted-foreground">
                      {visit.links.technician?.properties.name ?? "Unassigned"} ·{" "}
                      {visit.properties.number}
                    </span>
                  </span>
                  <StatusIndicator value={visit.properties.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Latest alarms" description="From building controls">
          {(alarms.data?.objects ?? []).length === 0 ? (
            <Empty>No alarms.</Empty>
          ) : (
            <ul className="px-6 pb-2">
              {(alarms.data?.objects ?? []).map((alarm) => (
                <li
                  key={alarm.primaryId}
                  className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-3 border-t border-border/70 py-3.5 first:border-t-0"
                >
                  <span className="flex size-8 items-center justify-center rounded-full bg-muted">
                    <BellRing className="size-4 text-foreground/70" strokeWidth={1.8} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-medium">
                      {alarm.properties.message}
                    </span>
                    <span className="truncate text-[13px] text-muted-foreground">
                      {alarm.links.equipment?.properties.name ?? "Equipment"} ·{" "}
                      {formatRelativeTime(alarm.properties.observedAt)}
                    </span>
                  </span>
                  <StatusBadge value={alarm.properties.severity} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Equipment to watch"
          action={
            <Link to="/equipment" className="font-medium text-primary hover:underline">
              All equipment
            </Link>
          }
        >
          {watchedEquipment.length === 0 ? (
            <Empty>Every unit reads healthy.</Empty>
          ) : (
            <ul className="px-6 pb-2">
              {watchedEquipment.slice(0, 5).map((item) => (
                <li key={item.primaryId} className="border-t border-border/70 first:border-t-0">
                  <Link
                    to={`/equipment/${encodeURIComponent(item.primaryId)}`}
                    className="group grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-3 py-3.5"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[15px] font-medium group-hover:text-primary">
                        {item.properties.name}
                      </span>
                      <span className="truncate text-[13px] text-muted-foreground">
                        {item.links.facility?.properties.name ?? "Facility"} ·{" "}
                        {item.properties.healthReason ?? "Readings outside range"}
                      </span>
                    </span>
                    <StatusIndicator value={item.properties.health} />
                    <ChevronRight className="size-4 text-muted-foreground/60" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

function DecisionRow({ item }: { item: CaseRow }) {
  const decision = decisions[item.properties.status]
  const primary = item.properties.status === "triage"
  return (
    <li className="flex items-center gap-4 border-t border-border/70 py-3.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] font-semibold text-primary">{decision?.label}</span>
        <span className="truncate text-[15.5px] font-semibold">
          {item.properties.number} · {item.properties.title}
        </span>
        <span className="truncate text-[13px] text-muted-foreground">
          {item.links.customer?.properties.name ?? "Customer"} ·{" "}
          {deadlineLabel(item.properties.responseDeadline)}
        </span>
      </span>
      <Link
        to={`/service-cases/${encodeURIComponent(item.primaryId)}`}
        className={cn(
          "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          primary
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-black/[0.05] text-foreground hover:bg-black/[0.08] dark:bg-white/[0.08]"
        )}
      >
        {decision?.action}
        {primary ? <ArrowUpRight className="size-3.5" /> : null}
      </Link>
    </li>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-6 pt-2 pb-7 text-[14px] text-muted-foreground">{children}</p>
}

function healthRank(health: string | undefined): number {
  return health === "offline" ? 0 : health === "unhealthy" ? 1 : 2
}

function isToday(value: string | Date | undefined): boolean {
  if (!value) return false
  const date = new Date(value)
  const now = new Date()
  return date.toDateString() === now.toDateString()
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
