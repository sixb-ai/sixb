import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Input } from "@sixb/ui/components"
import { ArrowRight, ArrowUpDown, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Technician } from "../../ontology/technician"
import { WorkOrder } from "../../ontology/work-order"
import { formatDateTime, humanize, QueryState, StatusIndicator } from "../_components/ui"

const techniciansQuery = objects(Technician).query().orderBy(Technician.p.name, "asc").limit(100)
const workOrdersQuery = objects(WorkOrder)
  .query()
  .expand(WorkOrder.l.assignee)
  .expand(WorkOrder.l.serviceCase)
  .expand(WorkOrder.l.equipment)
  .limit(100)

const views = [
  ["all", "All"],
  ["available", "Available"],
  ["assigned", "Assigned"],
  ["off_duty", "Off duty"],
] as const

const sortOptions = [
  ["availability", "Availability"],
  ["name", "Technician name"],
  ["territory", "Territory"],
] as const

type View = (typeof views)[number][0]
type Sort = (typeof sortOptions)[number][0]
type TechnicianRow = NonNullable<Awaited<ReturnType<typeof techniciansQuery.first>>>
type WorkOrderRow = NonNullable<Awaited<ReturnType<typeof workOrdersQuery.first>>>

export default function TechniciansPage() {
  const technicians = useObjectsQuery(techniciansQuery)
  const workOrders = useObjectsQuery(workOrdersQuery)
  const [view, setView] = useState<View>("all")
  const [sort, setSort] = useState<Sort>("availability")
  const [search, setSearch] = useState("")
  const allTechnicians = technicians.data?.objects ?? []
  const allWorkOrders = workOrders.data?.objects ?? []
  const available = allTechnicians.filter(
    (technician) => technician.properties.availability === "available"
  ).length
  const assigned = allTechnicians.filter(
    (technician) => technician.properties.availability === "assigned"
  ).length
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allTechnicians
      .filter((technician) => {
        if (view !== "all" && technician.properties.availability !== view) return false
        if (!normalized) return true
        const assignment = currentAssignment(technician, allWorkOrders)
        return [
          technician.properties.name,
          technician.properties.email,
          technician.properties.phone,
          humanize(technician.properties.territory),
          humanize(technician.properties.certification),
          assignment?.properties.number,
          assignment?.properties.title,
          assignment?.links.equipment?.properties.name,
        ].some((value) => value?.toLowerCase().includes(normalized))
      })
      .sort((left, right) => compareTechnicians(left, right, sort))
  }, [allTechnicians, allWorkOrders, search, sort, view])

  return (
    <div className="pb-8">
      <header className="mb-6 flex items-start justify-between gap-6 max-sm:flex-col">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Field response
          </p>
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
            Technicians
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Dispatchability, qualifications, and current field commitments across Northline
            territories.
          </p>
        </div>
        <div className="flex shrink-0 gap-8 text-right max-sm:text-left">
          <span>
            <strong className="block font-mono text-xl font-semibold">{available}</strong>
            <span className="text-xs text-muted-foreground">available now</span>
          </span>
          <span>
            <strong className="block font-mono text-xl font-semibold">{assigned}</strong>
            <span className="text-xs text-muted-foreground">in the field</span>
          </span>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <label className="relative block">
          <span className="sr-only">Search technicians</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search technicians, territories, or qualifications"
            className="h-12 rounded-lg border-border/90 bg-card pl-11 text-sm shadow-none focus-visible:ring-2"
          />
        </label>

        <label className="relative block">
          <span className="sr-only">Sort technicians</span>
          <ArrowUpDown
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            className="h-12 w-full appearance-none rounded-lg border border-border/90 bg-card pr-10 pl-11 text-sm font-medium text-foreground outline-none transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span
            className="pointer-events-none absolute top-1/2 right-4 size-2.5 -translate-y-2/3 rotate-45 border-r border-b border-muted-foreground"
            aria-hidden="true"
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="Technician views">
        {views.map(([value, label]) => {
          const count = allTechnicians.filter(
            (technician) => value === "all" || technician.properties.availability === value
          ).length
          const active = view === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              className={
                active
                  ? "h-9 shrink-0 rounded-md border border-primary bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-sm"
                  : "h-9 shrink-0 rounded-md border border-border/90 bg-card px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground"
              }
              onClick={() => setView(value)}
            >
              {label} <span className="ml-1.5 font-mono text-[10px] opacity-75">{count}</span>
            </button>
          )
        })}
      </div>

      <section className="mt-4">
        <header className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h2 className="text-base font-semibold tracking-[-0.015em]">Field team</h2>
          <p className="text-xs text-muted-foreground">
            Coverage, qualifications, current commitment, and next availability.
          </p>
        </header>
        <QueryState
          loading={technicians.isLoading || workOrders.isLoading}
          error={technicians.isError || workOrders.isError}
          empty={rows.length === 0}
          emptyMessage="No technicians match this view."
        >
          <div className="grid gap-2.5">
            {rows.map((technician) => (
              <TechnicianWorklistRow
                key={technician.primaryId}
                technician={technician}
                assignment={currentAssignment(technician, allWorkOrders)}
              />
            ))}
          </div>
        </QueryState>
      </section>
    </div>
  )
}

function TechnicianWorklistRow({
  technician,
  assignment,
}: {
  technician: TechnicianRow
  assignment: WorkOrderRow | undefined
}) {
  return (
    <Link
      to={`/technicians/${encodeURIComponent(technician.primaryId)}`}
      className="group relative grid grid-cols-[58px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 rounded-xl border border-border/85 bg-card py-3.5 pr-11 pl-3.5 transition-[border-color,background-color,box-shadow] hover:border-primary/70 hover:bg-primary/[0.045] hover:shadow-[0_1px_2px_rgba(13,32,39,0.04)] focus-visible:border-primary/70 focus-visible:bg-primary/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:grid-cols-[58px_minmax(170px,0.85fr)_minmax(170px,0.72fr)_minmax(260px,1.15fr)_190px_120px_18px] xl:gap-x-5 xl:pr-5"
    >
      <span className="grid size-[58px] shrink-0 place-items-center rounded-full bg-primary/14 text-base font-semibold tracking-[-0.025em] text-primary">
        {initials(technician.properties.name)}
      </span>

      <div className="min-w-0">
        <strong className="block truncate text-sm font-semibold group-hover:text-primary">
          {technician.properties.name}
        </strong>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {technician.properties.phone ?? technician.properties.email}
        </span>
      </div>

      <div className="col-start-2 min-w-0 border-t border-border/65 pt-3 xl:col-start-auto xl:border-0 xl:pt-0">
        <span className="block text-xs font-medium">
          {humanize(technician.properties.territory)} territory
        </span>
        <span className="mt-1.5 block text-xs text-muted-foreground">
          {humanize(technician.properties.certification)} certified
        </span>
      </div>

      <div className="col-start-2 min-w-0 xl:col-start-auto">
        {assignment ? (
          <>
            <span className="flex items-center gap-2">
              <strong className="font-mono text-xs font-semibold">
                {assignment.properties.number}
              </strong>
              <StatusIndicator value={assignment.properties.status} />
            </span>
            <span className="mt-1.5 block truncate text-xs font-medium">
              {assignment.properties.title}
            </span>
            <span className="mt-1 block truncate text-[11px] text-muted-foreground">
              {assignment.links.equipment?.properties.name ?? "Equipment"} ·{" "}
              {assignment.links.serviceCase?.properties.number ?? "Service case"}
            </span>
          </>
        ) : (
          <>
            <span className="block text-xs font-medium">Open capacity</span>
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              Ready for dispatch
            </span>
          </>
        )}
      </div>

      <div className="col-start-2 text-xs xl:col-start-auto">
        {assignment ? (
          <>
            <span className="block text-muted-foreground">Scheduled</span>
            <strong className="mt-1.5 block font-mono text-[11px] font-medium text-foreground">
              {formatDateTime(assignment.properties.scheduledStart)}
            </strong>
          </>
        ) : (
          <>
            <span className="block text-muted-foreground">Next window</span>
            <strong className="mt-1.5 block text-xs font-medium text-[color:var(--success)]">
              Available now
            </strong>
          </>
        )}
      </div>

      <div className="col-start-2 xl:col-start-auto">
        <StatusIndicator value={technician.properties.availability} />
      </div>

      <ArrowRight
        className="absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary xl:static xl:translate-y-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </Link>
  )
}

function currentAssignment(
  technician: TechnicianRow,
  workOrders: readonly WorkOrderRow[]
): WorkOrderRow | undefined {
  return workOrders
    .filter(
      (workOrder) =>
        workOrder.links.assignee?.primaryId === technician.primaryId &&
        !["completed", "cancelled"].includes(workOrder.properties.status)
    )
    .sort(
      (left, right) =>
        timestamp(left.properties.scheduledStart) - timestamp(right.properties.scheduledStart)
    )[0]
}

function compareTechnicians(left: TechnicianRow, right: TechnicianRow, sort: Sort): number {
  if (sort === "name") return left.properties.name.localeCompare(right.properties.name)
  if (sort === "territory") {
    return (
      left.properties.territory.localeCompare(right.properties.territory) ||
      left.properties.name.localeCompare(right.properties.name)
    )
  }
  const availability =
    availabilityPriority(right.properties.availability) -
    availabilityPriority(left.properties.availability)
  return (
    availability ||
    left.properties.territory.localeCompare(right.properties.territory) ||
    left.properties.name.localeCompare(right.properties.name)
  )
}

function timestamp(value: string | Date | undefined): number {
  return value ? new Date(value).getTime() : Number.POSITIVE_INFINITY
}

function availabilityPriority(status: string): number {
  return { available: 30, assigned: 20, off_duty: 0 }[
    status as "available" | "assigned" | "off_duty"
  ]
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
