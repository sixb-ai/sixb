import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Input } from "@sixb/ui/components"
import { ArrowRight, ArrowUpDown, Radio, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Equipment } from "../../ontology/equipment"
import { ServiceCase } from "../../ontology/service-case"
import { formatRelativeTime, QueryState, StatusIndicator } from "../_components/ui"

const equipmentQuery = objects(Equipment)
  .query()
  .expand(Equipment.l.facility)
  .orderBy(Equipment.p.name, "asc")
  .limit(200)
const casesQuery = objects(ServiceCase).query().expand(ServiceCase.l.equipment).limit(100)

const views = [
  ["all", "All"],
  ["attention", "Needs attention"],
  ["critical", "Critical assets"],
  ["rooftop_unit", "Rooftop units"],
  ["air_handler", "Air handlers"],
  ["controller", "Controls"],
] as const

const sortOptions = [
  ["priority", "Operational priority"],
  ["name", "Equipment name"],
  ["facility", "Facility"],
  ["signal", "Signal freshness"],
] as const

type View = (typeof views)[number][0]
type Sort = (typeof sortOptions)[number][0]
type EquipmentRow = NonNullable<Awaited<ReturnType<typeof equipmentQuery.first>>>
type CaseRow = NonNullable<Awaited<ReturnType<typeof casesQuery.first>>>

export default function EquipmentPage() {
  const equipment = useObjectsQuery(equipmentQuery)
  const cases = useObjectsQuery(casesQuery)
  const [view, setView] = useState<View>("all")
  const [sort, setSort] = useState<Sort>("priority")
  const [search, setSearch] = useState("")
  const allAssets = equipment.data?.objects ?? []
  const allCases = cases.data?.objects ?? []
  const attentionCount = allAssets.filter((asset) => asset.properties.health !== "healthy").length
  const reportingCount = allAssets.filter((asset) => asset.properties.health !== "offline").length
  const assets = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allAssets
      .filter((asset) => {
        if (!matchesView(asset, view)) return false
        if (!normalized) return true
        return [
          asset.properties.name,
          asset.properties.serialNumber,
          asset.properties.manufacturer,
          asset.properties.model,
          asset.links.facility?.properties.name,
        ].some((value) => value?.toLowerCase().includes(normalized))
      })
      .sort((left, right) => compareEquipment(left, right, sort))
  }, [allAssets, search, sort, view])

  return (
    <div className="pb-8">
      <header className="mb-6 flex items-start justify-between gap-6 max-sm:flex-col">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Connected assets
          </p>
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
            Equipment
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Monitored HVAC and controls assets, ordered by condition and operational attention.
          </p>
        </div>
        <div className="flex shrink-0 gap-8 text-right max-sm:text-left">
          <span>
            <strong className="block font-mono text-xl font-semibold">{attentionCount}</strong>
            <span className="text-xs text-muted-foreground">need attention</span>
          </span>
          <span>
            <strong className="block font-mono text-xl font-semibold">{reportingCount}</strong>
            <span className="text-xs text-muted-foreground">reporting</span>
          </span>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <label className="relative block">
          <span className="sr-only">Search equipment</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search equipment, serial, or facility"
            className="h-12 rounded-lg border-border/90 bg-card pl-11 text-sm shadow-none focus-visible:ring-2"
          />
        </label>

        <label className="relative block">
          <span className="sr-only">Sort equipment</span>
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

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="Equipment views">
        {views.map(([value, label]) => {
          const count = allAssets.filter((asset) => matchesView(asset, value)).length
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
          <h2 className="text-base font-semibold tracking-[-0.015em]">Connected equipment</h2>
          <p className="text-xs text-muted-foreground">
            Condition evidence, location, response, and signal freshness.
          </p>
        </header>
        <QueryState
          loading={equipment.isLoading || cases.isLoading}
          error={equipment.isError || cases.isError}
          empty={assets.length === 0}
          emptyMessage="No connected equipment matches this view."
        >
          <div className="grid gap-2.5">
            {assets.map((asset) => (
              <EquipmentWorklistRow
                key={asset.primaryId}
                asset={asset}
                activeCase={activeCaseFor(asset, allCases)}
              />
            ))}
          </div>
        </QueryState>
      </section>
    </div>
  )
}

function EquipmentWorklistRow({
  asset,
  activeCase,
}: {
  asset: EquipmentRow
  activeCase: CaseRow | undefined
}) {
  const health = asset.properties.health ?? "offline"
  return (
    <Link
      to={`/equipment/${encodeURIComponent(asset.primaryId)}`}
      className="group relative grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 rounded-xl border border-border/85 bg-card py-3 pr-11 pl-3 transition-[border-color,background-color,box-shadow] hover:border-primary/70 hover:bg-primary/[0.045] hover:shadow-[0_1px_2px_rgba(13,32,39,0.04)] focus-visible:border-primary/70 focus-visible:bg-primary/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:grid-cols-[92px_minmax(170px,1.05fr)_minmax(185px,0.9fr)_minmax(190px,0.95fr)_165px_118px_18px] xl:gap-x-5 xl:pr-5"
    >
      <EquipmentThumbnail asset={asset} />

      <div className="min-w-0 self-center">
        <strong className="block truncate text-base font-semibold tracking-[-0.015em] group-hover:text-primary">
          {asset.properties.name}
        </strong>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {asset.properties.manufacturer} · {asset.properties.model}
        </span>
        <span className="mt-1.5 block truncate font-mono text-[11px] text-muted-foreground">
          {asset.properties.serialNumber}
        </span>
      </div>

      <div className="col-start-2 min-w-0 border-t border-border/65 pt-3 xl:col-start-auto xl:border-0 xl:pt-0">
        <StatusIndicator value={health} />
        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {conditionEvidence(asset)}
        </p>
      </div>

      <div className="col-start-2 min-w-0 xl:col-start-auto">
        <span className="block truncate text-sm font-medium">
          {asset.links.facility?.properties.name ?? "Facility"}
        </span>
        <StatusIndicator value={asset.properties.criticality} className="mt-2" />
      </div>

      <div className="col-start-2 min-w-0 xl:col-start-auto">
        {activeCase ? (
          <>
            <span className="block font-mono text-xs font-semibold text-primary">
              {activeCase.properties.number}
            </span>
            <StatusIndicator value={activeCase.properties.status} className="mt-2" />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">No active service</span>
        )}
      </div>

      <div className="col-start-2 flex items-center gap-1.5 text-xs text-muted-foreground xl:col-start-auto xl:justify-end">
        <Radio className="size-3.5 shrink-0 text-primary" strokeWidth={1.8} />
        <span>Seen {formatRelativeTime(asset.properties.lastSeenAt)}</span>
      </div>

      <ArrowRight
        className="absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary xl:static xl:translate-y-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </Link>
  )
}

function EquipmentThumbnail({ asset }: { asset: EquipmentRow }) {
  const illustration = equipmentIllustration(asset.properties.name, asset.properties.equipmentType)
  return (
    <span className="grid size-[76px] shrink-0 place-items-center overflow-hidden rounded-lg border border-primary/15 bg-secondary/70 xl:size-[92px]">
      <img
        src={illustration.src}
        alt=""
        className={
          illustration.contain ? "size-full object-contain p-1.5" : "size-full object-cover"
        }
      />
      <span className="sr-only">{asset.properties.name}</span>
    </span>
  )
}

function equipmentIllustration(equipmentName: string, equipmentType: string) {
  const normalized = equipmentName.toLowerCase()
  if (normalized === "rtu-2") return { src: "/illustrations/rtu-2.webp", contain: false }
  if (normalized === "rtu-7") return { src: "/illustrations/rtu-7.webp", contain: false }
  if (equipmentType === "rooftop_unit") {
    return { src: "/illustrations/rtu-7.webp", contain: false }
  }
  if (equipmentType === "air_handler") {
    return { src: "/illustrations/ahu-3.webp", contain: false }
  }
  if (equipmentType === "controller") {
    return { src: "/illustrations/building-controller.webp", contain: false }
  }
  if (equipmentType === "boiler") {
    return { src: "/illustrations/boiler-2.webp", contain: true }
  }
  if (equipmentType === "chiller") {
    return { src: "/illustrations/chiller-1.webp", contain: false }
  }
  return { src: "/illustrations/heat-pump-4.webp", contain: false }
}

function activeCaseFor(asset: EquipmentRow, cases: CaseRow[]): CaseRow | undefined {
  return cases.find(
    (serviceCase) =>
      serviceCase.links.equipment?.primaryId === asset.primaryId &&
      !["closed", "cancelled"].includes(serviceCase.properties.status)
  )
}

function matchesView(asset: EquipmentRow, view: View): boolean {
  if (view === "all") return true
  if (view === "attention") return asset.properties.health !== "healthy"
  if (view === "critical") return asset.properties.criticality === "critical"
  return asset.properties.equipmentType === view
}

function compareEquipment(left: EquipmentRow, right: EquipmentRow, sort: Sort): number {
  if (sort === "name") return left.properties.name.localeCompare(right.properties.name)
  if (sort === "facility") {
    return (left.links.facility?.properties.name ?? "").localeCompare(
      right.links.facility?.properties.name ?? ""
    )
  }
  if (sort === "signal") {
    return timestamp(right.properties.lastSeenAt) - timestamp(left.properties.lastSeenAt)
  }
  const priority = equipmentPriority(right) - equipmentPriority(left)
  return priority || left.properties.name.localeCompare(right.properties.name)
}

function equipmentPriority(asset: EquipmentRow): number {
  const health = { offline: 50, unhealthy: 40, watch: 25, healthy: 0 }[
    asset.properties.health ?? "offline"
  ]
  const criticality = { critical: 8, important: 4, standard: 0 }[asset.properties.criticality]
  return health + criticality
}

function conditionEvidence(asset: EquipmentRow): string {
  const reason = asset.properties.healthReason
  if (!reason) return "Readings within expected range"
  const normalized = reason.replaceAll("_", " ").toLowerCase()
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function timestamp(value: string | Date | undefined): number {
  return value ? new Date(value).getTime() : 0
}
