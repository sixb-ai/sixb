import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ServiceCase } from "../../ontology/service-case"
import { deadlineLabel, PageHeader, QueryState, StatusBadge, statusTone } from "../_components/ui"
import { equipmentIcon, equipmentIllustration } from "../_lib/equipment"

const allCases = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .orderBy(ServiceCase.p.responseDeadline, "asc")
  .limit(100)

const views = [
  ["open", "Open"],
  ["dispatch", "Needs dispatch"],
  ["in_service", "In service"],
  ["awaiting_authorization", "Authorization"],
  ["sla", "At risk"],
  ["resolved", "Ready to close"],
  ["all", "All"],
] as const

type View = (typeof views)[number][0]
type CaseRow = NonNullable<Awaited<ReturnType<typeof allCases.first>>>

export default function ServiceCasesPage() {
  const query = useObjectsQuery(allCases)
  const [view, setView] = useState<View>("open")
  const [search, setSearch] = useState("")
  const allRows = query.data?.objects ?? []
  const counts = useMemo(
    () =>
      Object.fromEntries(
        views.map(([id]) => [id, allRows.filter((row) => matchesView(row, id)).length])
      ),
    [allRows]
  )
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allRows
      .filter((item) => matchesView(item, view))
      .filter((item) => {
        if (!normalized) return true
        return [
          item.properties.number,
          item.properties.title,
          item.properties.nextAction,
          item.links.customer?.properties.name,
          item.links.facility?.properties.name,
          item.links.equipment?.properties.name,
        ].some((value) => value?.toLowerCase().includes(normalized))
      })
      .sort((left, right) => casePriority(right) - casePriority(left))
  }, [allRows, search, view])

  return (
    <div>
      <PageHeader
        title="Service cases"
        description="Customer-impacting issues, most urgent first."
        action={
          <label className="relative block w-72 max-sm:w-full">
            <span className="sr-only">Search service cases</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.8}
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search cases, customers, equipment"
              className="h-10 w-full rounded-[10px] bg-black/[0.045] pr-3 pl-10 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/[0.07]"
            />
          </label>
        }
      >
        <div role="tablist" aria-label="Case views" className="-mx-1 flex flex-wrap gap-1.5">
          {views.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                view === id
                  ? "bg-foreground text-background"
                  : "bg-black/[0.045] text-foreground/80 hover:bg-black/[0.07] dark:bg-white/[0.07]"
              )}
            >
              {label}
              <span
                className={cn(
                  "text-[12.5px] tabular-nums",
                  view === id ? "text-background/70" : "text-muted-foreground"
                )}
              >
                {counts[id] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </PageHeader>

      <section className="overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
        <QueryState
          loading={query.isLoading}
          error={query.isError}
          empty={rows.length === 0}
          emptyMessage={search ? "No cases match that search." : "No cases in this view."}
        >
          <ul>
            {rows.map((serviceCase) => (
              <CaseListRow key={serviceCase.primaryId} serviceCase={serviceCase} />
            ))}
          </ul>
        </QueryState>
      </section>
    </div>
  )
}

function CaseListRow({ serviceCase }: { serviceCase: CaseRow }) {
  const equipment = serviceCase.links.equipment
  const illustration = equipmentIllustration(
    equipment?.properties.name,
    equipment?.properties.equipmentType
  )
  const Icon = equipmentIcon(equipment?.properties.equipmentType)
  const closed = ["closed", "cancelled"].includes(serviceCase.properties.status ?? "")
  const deadlineTone = statusTone(serviceCase.properties.slaStatus)

  return (
    <li className="border-t border-border/70 first:border-t-0">
      <Link
        to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
        className="group grid grid-cols-[3.5rem_minmax(0,1fr)_auto_1rem] items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none sm:px-6 dark:hover:bg-white/[0.03]"
      >
        <span className="relative flex size-14 items-center justify-center overflow-hidden rounded-[14px] bg-muted">
          {illustration ? (
            <img
              src={illustration.src}
              alt=""
              className={cn(
                "size-full",
                illustration.contain ? "object-contain p-1.5" : "object-cover"
              )}
            />
          ) : (
            <Icon className="size-6 text-foreground/55" strokeWidth={1.6} />
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[13px] font-semibold text-muted-foreground tabular-nums">
              {serviceCase.properties.number}
            </span>
            <span
              className={cn(
                "truncate text-[16px] font-semibold tracking-[-0.01em] group-hover:text-primary",
                closed && "text-foreground/60"
              )}
            >
              {serviceCase.properties.title}
            </span>
          </span>
          <span className="truncate text-[13.5px] text-muted-foreground">
            {serviceCase.links.customer?.properties.name ?? "Customer"} ·{" "}
            {serviceCase.links.facility?.properties.name ?? "Facility"}
            {serviceCase.properties.nextAction && !closed
              ? ` · ${serviceCase.properties.nextAction}`
              : ""}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1.5">
          <span className="flex items-center gap-2">
            {serviceCase.properties.severity === "critical" ||
            serviceCase.properties.severity === "high" ? (
              <StatusBadge value={serviceCase.properties.severity} />
            ) : null}
            <StatusBadge value={serviceCase.properties.status} />
          </span>
          <span
            className={cn(
              "text-[13px] font-medium tabular-nums",
              closed
                ? "text-muted-foreground"
                : deadlineTone === "critical"
                  ? "text-destructive"
                  : deadlineTone === "warning"
                    ? "text-[color:var(--warning)]"
                    : "text-foreground/70"
            )}
          >
            {closed
              ? serviceCase.properties.slaStatus === "met"
                ? "Commitment met"
                : "Closed"
              : deadlineLabel(serviceCase.properties.responseDeadline)}
          </span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground" />
      </Link>
    </li>
  )
}

function matchesView(serviceCase: CaseRow, view: View): boolean {
  const status = serviceCase.properties.status ?? ""
  const closed = ["closed", "cancelled"].includes(status)
  if (view === "all") return true
  if (view === "open") return !closed
  if (view === "dispatch") return ["new", "triage", "dispatching"].includes(status)
  if (view === "sla") {
    return !closed && ["at_risk", "breached"].includes(serviceCase.properties.slaStatus ?? "")
  }
  return status === view
}

function casePriority(serviceCase: CaseRow): number {
  const severity =
    { critical: 40, high: 30, medium: 20, low: 10 }[serviceCase.properties.severity ?? "low"] ?? 0
  const sla =
    { breached: 30, at_risk: 20, on_track: 0, met: -10 }[
      serviceCase.properties.slaStatus ?? "on_track"
    ] ?? 0
  const state = ["closed", "cancelled"].includes(serviceCase.properties.status ?? "") ? -100 : 0
  const deadline = new Date(serviceCase.properties.responseDeadline ?? Date.now()).getTime()
  // Earlier deadlines win ties within the same severity and risk.
  return severity + sla + state - deadline / 1e13
}
