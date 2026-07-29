import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Input } from "@sixb/ui/components"
import { ArrowRight, ArrowUpDown, Cpu, Fan, Search, Snowflake, Wind } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ServiceCase } from "../../ontology/service-case"
import { deadlineLabel, QueryState, StatusIndicator } from "../_components/ui"

const allCases = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .orderBy(ServiceCase.p.responseDeadline, "asc")
  .limit(100)

const views = [
  ["all", "All"],
  ["new", "New"],
  ["dispatch", "Needs dispatch"],
  ["in_service", "In service"],
  ["awaiting_authorization", "Authorization"],
  ["sla", "SLA risk"],
  ["resolved", "Ready to close"],
] as const

const sortOptions = [
  ["urgency", "Urgency"],
  ["commitment", "Commitment"],
  ["number", "Case number"],
] as const

type View = (typeof views)[number][0]
type Sort = (typeof sortOptions)[number][0]
type CaseRow = NonNullable<Awaited<ReturnType<typeof allCases.first>>>

export default function ServiceCasesPage() {
  const query = useObjectsQuery(allCases)
  const [view, setView] = useState<View>("all")
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<Sort>("urgency")
  const allRows = query.data?.objects ?? []
  const activeCount = allRows.filter(
    (item) => !["closed", "cancelled"].includes(item.properties.status)
  ).length
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allRows
      .filter((item) => {
        if (!matchesView(item, view)) return false
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
      .sort((left, right) => compareCases(left, right, sort))
  }, [allRows, search, sort, view])

  return (
    <div className="pb-8">
      <header className="mb-6 flex items-start justify-between gap-6 max-sm:flex-col">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Operations worklist
          </p>
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
            Service cases
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Customer-impacting issues ordered by urgency and commitment risk.
          </p>
        </div>
        <div className="flex shrink-0 items-baseline gap-2 pt-1 text-foreground">
          <strong className="font-mono text-xl font-semibold">{activeCount}</strong>
          <span className="text-sm text-muted-foreground">active</span>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        <label className="relative block">
          <span className="sr-only">Search service cases</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search cases, customers, or equipment"
            className="h-12 rounded-lg border-border/90 bg-card pl-11 text-sm shadow-none focus-visible:ring-2"
          />
        </label>

        <label className="relative block">
          <span className="sr-only">Sort service cases</span>
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

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="Service case views">
        {views.map(([value, label]) => {
          const count = allRows.filter((item) => matchesView(item, value)).length
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

      <section className="mt-3">
        <QueryState
          loading={query.isLoading}
          error={query.isError}
          empty={rows.length === 0}
          emptyMessage="No service cases match this view."
        >
          <div className="grid gap-2.5">
            {rows.map((serviceCase) => (
              <ServiceCaseRow key={serviceCase.primaryId} serviceCase={serviceCase} />
            ))}
          </div>
        </QueryState>
      </section>
    </div>
  )
}

function ServiceCaseRow({ serviceCase }: { serviceCase: CaseRow }) {
  const equipment = serviceCase.links.equipment?.properties

  return (
    <Link
      to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
      className="group relative grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 rounded-xl border border-border/85 bg-card py-3.5 pr-11 pl-3.5 transition-[border-color,background-color,box-shadow] hover:border-primary/70 hover:bg-primary/[0.045] hover:shadow-[0_1px_2px_rgba(13,32,39,0.04)] focus-visible:border-primary/70 focus-visible:bg-primary/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-[84px_minmax(0,1.35fr)_minmax(210px,0.78fr)_145px_20px] lg:gap-x-5 lg:pr-5"
    >
      <EquipmentThumbnail
        equipmentType={equipment?.equipmentType}
        equipmentName={equipment?.name ?? "Equipment"}
      />

      <div className="min-w-0 self-center">
        <div className="flex flex-wrap items-center gap-2.5">
          <strong className="font-mono text-xs font-semibold tracking-[-0.01em]">
            {serviceCase.properties.number}
          </strong>
          <StatusIndicator value={serviceCase.properties.severity} />
        </div>
        <p className="mt-1.5 truncate text-sm font-semibold tracking-[-0.012em] text-foreground group-hover:text-primary">
          {serviceCase.properties.title}
        </p>
        <p className="mt-1 truncate text-xs font-medium text-foreground/85">
          {serviceCase.links.customer?.properties.name ?? "Customer"}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {serviceCase.links.facility?.properties.name ?? "Facility"} ·{" "}
          {equipment?.name ?? "Equipment"}
        </p>
      </div>

      <div className="col-start-2 min-w-0 border-t border-border/65 pt-3 lg:col-start-auto lg:border-0 lg:pt-0">
        <StatusIndicator value={serviceCase.properties.status} />
        <p className="mt-1.5 truncate text-xs font-medium text-foreground">
          {serviceCase.properties.nextAction}
        </p>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {serviceCase.properties.ownerName ?? "Unassigned"}
        </p>
      </div>

      <div className="col-start-2 flex items-center gap-4 lg:col-start-auto lg:block lg:text-right">
        <strong className={`block font-mono text-xs ${deadlineTone(serviceCase)}`}>
          {commitmentLabel(serviceCase)}
        </strong>
        <StatusIndicator
          value={serviceCase.properties.slaStatus}
          className="lg:mt-1.5 lg:justify-end"
        />
      </div>

      <ArrowRight
        className="absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary lg:static lg:translate-y-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </Link>
  )
}

function EquipmentThumbnail({
  equipmentType,
  equipmentName,
}: {
  equipmentType: string | undefined
  equipmentName: string
}) {
  const illustration = equipmentIllustration(equipmentName, equipmentType)

  if (illustration) {
    return (
      <span className="grid size-[72px] place-items-center overflow-hidden rounded-lg border border-primary/20 bg-secondary/75 lg:size-[84px]">
        <img
          src={illustration.src}
          alt=""
          className={
            illustration.contain
              ? "h-[68px] w-[68px] object-contain p-1 lg:h-[80px] lg:w-[80px]"
              : "size-full object-cover"
          }
        />
        <span className="sr-only">{equipmentName}</span>
      </span>
    )
  }

  const Icon = equipmentIcon(equipmentType)
  return (
    <span className="relative grid size-[72px] place-items-center overflow-hidden rounded-lg border border-primary/15 bg-secondary/75 lg:size-[84px]">
      <span className="relative grid h-11 w-13 place-items-center rounded-[7px] border border-primary/25 bg-primary/15 text-primary shadow-[0_4px_0_rgba(47,114,128,0.12)] lg:h-12 lg:w-14">
        <Icon className="size-6" strokeWidth={1.55} aria-hidden="true" />
        <span className="absolute right-1.5 bottom-1.5 flex gap-1" aria-hidden="true">
          <span className="size-1 rounded-full bg-primary/55" />
          <span className="size-1 rounded-full bg-[color:var(--northline-copper)]/70" />
        </span>
      </span>
      <span className="sr-only">{equipmentName}</span>
    </span>
  )
}

function equipmentIllustration(equipmentName: string, equipmentType: string | undefined) {
  const normalized = equipmentName.toLowerCase()
  if (normalized === "rtu-2") return { src: "/illustrations/rtu-2.webp", contain: false }
  if (normalized === "rtu-7") return { src: "/illustrations/rtu-7.webp", contain: false }
  if (normalized === "ahu-3") return { src: "/illustrations/ahu-3.webp", contain: false }
  if (normalized.includes("controller")) {
    return { src: "/illustrations/building-controller.webp", contain: false }
  }
  if (equipmentType === "boiler") {
    return { src: "/illustrations/boiler-2.webp", contain: true }
  }
  return undefined
}

function equipmentIcon(equipmentType: string | undefined) {
  if (equipmentType === "rooftop_unit" || equipmentType === "heat_pump") return Fan
  if (equipmentType === "air_handler") return Wind
  if (equipmentType === "controller") return Cpu
  return Snowflake
}

function matchesView(serviceCase: CaseRow, view: View): boolean {
  return (
    view === "all" ||
    (view === "dispatch" && ["triage", "dispatching"].includes(serviceCase.properties.status)) ||
    (view === "sla" && ["at_risk", "breached"].includes(serviceCase.properties.slaStatus)) ||
    serviceCase.properties.status === view
  )
}

function compareCases(left: CaseRow, right: CaseRow, sort: Sort): number {
  if (sort === "number") {
    return right.properties.number.localeCompare(left.properties.number, undefined, {
      numeric: true,
    })
  }
  if (sort === "commitment") {
    const leftClosed = ["closed", "cancelled"].includes(left.properties.status)
    const rightClosed = ["closed", "cancelled"].includes(right.properties.status)
    if (leftClosed !== rightClosed) return leftClosed ? 1 : -1
    return (
      deadlineValue(left.properties.responseDeadline) -
      deadlineValue(right.properties.responseDeadline)
    )
  }
  return casePriority(right) - casePriority(left)
}

function deadlineValue(value: string | Date | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY
  return new Date(value).getTime()
}

function casePriority(serviceCase: CaseRow): number {
  const severity = { critical: 40, high: 30, medium: 20, low: 10 }[serviceCase.properties.severity]
  const sla = { breached: 30, at_risk: 20, on_track: 0, met: -10 }[serviceCase.properties.slaStatus]
  const state = ["closed", "cancelled"].includes(serviceCase.properties.status) ? -100 : 0
  return severity + sla + state
}

function commitmentLabel(serviceCase: CaseRow): string {
  if (["resolved", "closed"].includes(serviceCase.properties.status)) {
    return serviceCase.properties.slaStatus === "met" ? "Commitment met" : "Recovery recorded"
  }
  return deadlineLabel(serviceCase.properties.responseDeadline)
}

function deadlineTone(serviceCase: CaseRow): string {
  if (serviceCase.properties.slaStatus === "breached") return "text-destructive"
  if (serviceCase.properties.slaStatus === "at_risk") return "text-[color:var(--warning)]"
  if (serviceCase.properties.slaStatus === "met") return "text-[color:var(--success)]"
  return "text-foreground"
}
