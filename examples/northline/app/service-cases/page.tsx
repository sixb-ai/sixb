import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ServiceCase } from "../../ontology/service-case"
import { EquipmentThumb } from "../_components/equipment-picture"
import { SearchField, ViewPills } from "../_components/list-controls"
import { CaseClockText, PageHeader, QueryState, Section, StatusBadge } from "../_components/ui"
import type { QueryRow } from "../_lib/query-types"
import {
  type CaseView,
  casePath,
  casePriority,
  caseViews,
  inCaseView,
  isCaseOpen,
  useCasesWithFieldWorkDone,
} from "../_lib/service-cases"

const allCases = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  // Newest first, so past the limit the oldest cases drop; the page sorts by urgency itself.
  .orderBy(ServiceCase.p.detectedAt, "desc")
  .limit(100)

type CaseRow = QueryRow<typeof allCases>

export default function ServiceCasesPage() {
  const query = useObjectsQuery(allCases)
  const fieldWorkDone = useCasesWithFieldWorkDone()
  // The view lives in the URL so Home can link straight to one.
  const [params, setParams] = useSearchParams()
  const view = caseViews.find(([id]) => id === params.get("view"))?.[0] ?? "open"
  const setView = (next: CaseView) =>
    setParams(next === "open" ? {} : { view: next }, { replace: true })
  const [search, setSearch] = useState("")
  const allRows = query.data?.objects ?? []
  const counts = useMemo(
    () =>
      Object.fromEntries(
        caseViews.map(([id]) => [
          id,
          allRows.filter((row) => inCaseView(row, id, fieldWorkDone)).length,
        ])
      ),
    [allRows, fieldWorkDone]
  )
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allRows
      .filter((item) => inCaseView(item, view, fieldWorkDone))
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
      .sort((left, right) => casePriority(right.properties) - casePriority(left.properties))
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
          views={caseViews}
          value={view}
          counts={counts}
          onChange={setView}
        />
      </PageHeader>

      <Section className="overflow-hidden">
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
      </Section>
    </div>
  )
}

function CaseListRow({ serviceCase }: { serviceCase: CaseRow }) {
  const equipment = serviceCase.links.equipment
  const closed = !isCaseOpen(serviceCase.properties.status)

  return (
    <li className="border-t border-border/70 first:border-t-0">
      <Link
        to={casePath(serviceCase.primaryId)}
        className="group grid grid-cols-[3.5rem_minmax(0,1fr)_auto_1rem] items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none max-sm:grid-cols-[3rem_minmax(0,1fr)] max-sm:items-start max-sm:gap-x-3.5 max-sm:gap-y-2.5 sm:px-6 dark:hover:bg-white/[0.03]"
      >
        {/* On a phone the state and clock move under the text, which gets the full width. */}
        <EquipmentThumb
          name={equipment?.properties.name}
          type={equipment?.properties.equipmentType}
          className="size-14 rounded-[14px] max-sm:size-12 max-sm:rounded-[12px]"
        />
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
