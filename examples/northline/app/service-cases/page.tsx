import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ServiceCase } from "../../ontology/service-case"
import { SearchField, ViewPills } from "../_components/list-controls"
import {
  CaseClockText,
  caseClock,
  isCaseAtRisk,
  PageHeader,
  QueryState,
  StatusBadge,
} from "../_components/ui"
import { equipmentIcon, equipmentIllustration } from "../_lib/equipment"
import { caseDecision, useCasesWithFieldWorkDone } from "../_lib/service-cases"

const allCases = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .orderBy(ServiceCase.p.responseDeadline, "asc")
  .limit(100)

const views = [
  ["open", "Open"],
  ["action", "Needs you"],
  ["field", "In the field"],
  ["risk", "At risk"],
  ["all", "All"],
] as const

type View = (typeof views)[number][0]
type CaseRow = NonNullable<Awaited<ReturnType<typeof allCases.first>>>

export default function ServiceCasesPage() {
  const query = useObjectsQuery(allCases)
  const fieldWorkDone = useCasesWithFieldWorkDone()
  // The view lives in the URL so Home can link straight to one.
  const [params, setParams] = useSearchParams()
  const view = views.find(([id]) => id === params.get("view"))?.[0] ?? "open"
  const setView = (next: View) =>
    setParams(next === "open" ? {} : { view: next }, { replace: true })
  const [search, setSearch] = useState("")
  const allRows = query.data?.objects ?? []
  const counts = useMemo(
    () =>
      Object.fromEntries(
        views.map(([id]) => [
          id,
          allRows.filter((row) => matchesView(row, id, fieldWorkDone)).length,
        ])
      ),
    [allRows, fieldWorkDone]
  )
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allRows
      .filter((item) => matchesView(item, view, fieldWorkDone))
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
  }, [allRows, fieldWorkDone, search, view])

  return (
    <div>
      <PageHeader
        title="Service cases"
        description="Customer-impacting issues, most urgent first."
        action={
          <SearchField
            label="Search service cases"
            value={search}
            placeholder="Search cases, customers, equipment"
            onChange={setSearch}
          />
        }
      >
        <ViewPills
          label="Case views"
          views={views}
          value={view}
          counts={counts}
          onChange={setView}
        />
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

  return (
    <li className="border-t border-border/70 first:border-t-0">
      <Link
        to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
        className="group grid grid-cols-[3.5rem_minmax(0,1fr)_auto_1rem] items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none max-sm:grid-cols-[3rem_minmax(0,1fr)] max-sm:items-start max-sm:gap-x-3.5 max-sm:gap-y-2.5 sm:px-6 dark:hover:bg-white/[0.03]"
      >
        {/* On a phone the state and clock move under the text, which gets the full width. */}
        <span className="relative flex size-14 items-center justify-center overflow-hidden rounded-[14px] bg-muted max-sm:size-12 max-sm:rounded-[12px]">
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
          <span className="flex min-w-0 items-center gap-2 max-sm:items-baseline">
            <span className="shrink-0 text-[13px] font-semibold text-muted-foreground tabular-nums">
              {serviceCase.properties.number}
            </span>
            <span
              className={cn(
                "truncate text-[16px] font-semibold tracking-[-0.01em] group-hover:text-primary max-sm:line-clamp-2 max-sm:text-[15.5px] max-sm:leading-5 max-sm:whitespace-normal",
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
        <span className="flex flex-col items-end gap-1.5 max-sm:col-start-2 max-sm:flex-row max-sm:flex-wrap max-sm:items-center max-sm:justify-between">
          <span className="flex items-center gap-2">
            {serviceCase.properties.severity === "critical" ||
            serviceCase.properties.severity === "high" ? (
              <StatusBadge value={serviceCase.properties.severity} />
            ) : null}
            <StatusBadge value={serviceCase.properties.status} />
          </span>
          <CaseClockText
            serviceCase={serviceCase.properties}
            className="text-[13px] font-medium text-foreground/70"
          />
        </span>
        <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground max-sm:hidden" />
      </Link>
    </li>
  )
}

function matchesView(
  serviceCase: CaseRow,
  view: View,
  fieldWorkDone: ReadonlySet<string>
): boolean {
  const status = serviceCase.properties.status ?? ""
  if (view === "all") return true
  if (["closed", "cancelled"].includes(status)) return false
  if (view === "action") {
    return caseDecision(status, fieldWorkDone.has(serviceCase.primaryId)) !== undefined
  }
  if (view === "field") return ["dispatching", "in_service"].includes(status)
  if (view === "risk") return isCaseAtRisk(serviceCase.properties)
  return true
}

function casePriority(serviceCase: CaseRow): number {
  const severity =
    { critical: 40, high: 30, medium: 20, low: 10 }[serviceCase.properties.severity ?? "low"] ?? 0
  const sla =
    { breached: 30, at_risk: 20, on_track: 0, met: -10 }[
      serviceCase.properties.slaStatus ?? "on_track"
    ] ?? 0
  const state = ["closed", "cancelled"].includes(serviceCase.properties.status ?? "") ? -100 : 0
  const dueAt = caseClock(serviceCase.properties).dueAt
  // Earlier deadlines win ties within the same severity and risk.
  return severity + sla + state - (Number.isFinite(dueAt) ? dueAt : Date.now()) / 1e13
}
