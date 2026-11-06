import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Technician } from "../../ontology/technician"
import { WorkOrder } from "../../ontology/work-order"
import { SearchField, SortSelect, ViewPills } from "../_components/list-controls"
import {
  formatDateTime,
  humanize,
  initials,
  PageHeader,
  QueryState,
  StatusBadge,
} from "../_components/ui"

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
  ["availability", "By availability"],
  ["name", "By name"],
  ["territory", "By territory"],
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

  const counts = Object.fromEntries(
    views.map(([value]) => [
      value,
      allTechnicians.filter(
        (technician) => value === "all" || technician.properties.availability === value
      ).length,
    ])
  )

  return (
    <div>
      <PageHeader
        title="Technicians"
        description="Who is free, where they cover, and what each person is working on."
        action={
          <>
            <SearchField
              label="Search technicians"
              value={search}
              onChange={setSearch}
              placeholder="Search people, territories, work"
            />
            <SortSelect
              label="Sort technicians"
              value={sort}
              options={sortOptions}
              onChange={setSort}
            />
          </>
        }
      >
        <ViewPills
          label="Technician views"
          views={views}
          value={view}
          counts={counts}
          onChange={setView}
        />
      </PageHeader>

      <section className="overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
        <QueryState
          loading={technicians.isLoading || workOrders.isLoading}
          error={technicians.isError || workOrders.isError}
          empty={rows.length === 0}
          emptyMessage={
            search ? "No technicians match that search." : "No technicians in this view."
          }
        >
          <ul>
            {rows.map((technician) => (
              <TechnicianListRow
                key={technician.primaryId}
                technician={technician}
                assignment={currentAssignment(technician, allWorkOrders)}
              />
            ))}
          </ul>
        </QueryState>
      </section>
    </div>
  )
}

function TechnicianListRow({
  technician,
  assignment,
}: {
  technician: TechnicianRow
  assignment: WorkOrderRow | undefined
}) {
  const offDuty = technician.properties.availability === "off_duty"
  const assignmentDetail = assignment
    ? [
        assignment.properties.number,
        humanize(assignment.properties.status),
        assignment.links.equipment?.properties.name,
        assignment.links.serviceCase?.properties.number,
      ]
        .filter(Boolean)
        .join(" · ")
    : offDuty
      ? "Not on shift"
      : "Ready for dispatch"

  return (
    <li className="border-t border-border/70 first:border-t-0">
      <Link
        to={`/technicians/${encodeURIComponent(technician.primaryId)}`}
        className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none sm:px-6 dark:hover:bg-white/[0.03]"
      >
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold tracking-[-0.01em]",
            offDuty ? "bg-muted text-muted-foreground" : "bg-[var(--northline-tint)] text-primary"
          )}
          aria-hidden="true"
        >
          {initials(technician.properties.name)}
        </span>

        <span className="grid min-w-0 flex-1 gap-x-8 gap-y-2.5 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:items-center">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center justify-between gap-3">
              <span
                className={cn(
                  "truncate text-[16px] font-semibold tracking-[-0.01em] group-hover:text-primary",
                  offDuty && "text-foreground/60"
                )}
              >
                {technician.properties.name}
              </span>
              <span className="md:hidden">
                <StatusBadge value={technician.properties.availability} />
              </span>
            </span>
            <span className="truncate text-[13.5px] text-muted-foreground">
              {humanize(technician.properties.territory)} ·{" "}
              {humanize(technician.properties.certification)} certified
            </span>
          </span>

          <span className="flex min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                "truncate text-[14.5px] font-medium",
                assignment ? "text-foreground" : "text-foreground/60"
              )}
            >
              {assignment ? assignment.properties.title : "No current assignment"}
            </span>
            <span className="truncate text-[13px] text-muted-foreground tabular-nums">
              {assignmentDetail}
              {assignment ? (
                <span className="md:hidden">
                  {" "}
                  · {formatDateTime(assignment.properties.scheduledStart)}
                </span>
              ) : null}
            </span>
          </span>
        </span>

        <span className="hidden w-44 shrink-0 flex-col items-end gap-1.5 md:flex">
          <StatusBadge value={technician.properties.availability} />
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {assignment
              ? formatDateTime(assignment.properties.scheduledStart)
              : offDuty
                ? "Off shift"
                : "Available now"}
          </span>
        </span>

        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground"
          aria-hidden="true"
        />
      </Link>
    </li>
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
