import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Equipment } from "../../ontology/equipment"
import { ServiceCase } from "../../ontology/service-case"
import { EquipmentPicture } from "../_components/equipment-picture"
import { SearchField, ViewPills } from "../_components/list-controls"
import {
  formatRelativeTime,
  humanize,
  PageHeader,
  QueryState,
  StatusIndicator,
} from "../_components/ui"
import type { QueryRow } from "../_lib/query-types"

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
] as const

type View = (typeof views)[number][0]
type EquipmentRow = QueryRow<typeof equipmentQuery>

export default function EquipmentPage() {
  const equipment = useObjectsQuery(equipmentQuery)
  const cases = useObjectsQuery(casesQuery)
  const [view, setView] = useState<View>("all")
  const [search, setSearch] = useState("")
  const allAssets = equipment.data?.objects ?? []
  const openCaseByEquipment = useMemo(() => {
    const map = new Map<string, string>()
    for (const serviceCase of cases.data?.objects ?? []) {
      const equipmentId = serviceCase.links.equipment?.primaryId
      if (equipmentId && !["closed", "cancelled"].includes(serviceCase.properties.status ?? "")) {
        map.set(equipmentId, serviceCase.properties.number ?? "")
      }
    }
    return map
  }, [cases.data])
  const counts = useMemo(
    () =>
      Object.fromEntries(
        views.map(([id]) => [id, allAssets.filter((asset) => matchesView(asset, id)).length])
      ),
    [allAssets]
  )
  const assets = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allAssets
      .filter((asset) => matchesView(asset, view))
      .filter((asset) =>
        normalized
          ? [
              asset.properties.name,
              asset.properties.manufacturer,
              asset.properties.model,
              asset.links.facility?.properties.name,
            ].some((value) => value?.toLowerCase().includes(normalized))
          : true
      )
      .sort((left, right) => priority(right) - priority(left))
  }, [allAssets, search, view])

  return (
    <div>
      <PageHeader
        title="Equipment"
        description="Every unit Northline maintains, with its live condition from building controls."
        action={
          <SearchField
            label="Search equipment"
            value={search}
            placeholder="Search units, models, facilities"
            onChange={setSearch}
          />
        }
      >
        <ViewPills
          label="Equipment views"
          views={views}
          value={view}
          counts={counts}
          onChange={setView}
        />
      </PageHeader>

      <QueryState
        loading={equipment.isLoading}
        error={equipment.isError}
        empty={assets.length === 0}
        emptyMessage={search ? "No equipment matches that search." : "No equipment in this view."}
      >
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(16.5rem,100%),1fr))] gap-4">
          {assets.map((asset) => (
            <AssetCard
              key={asset.primaryId}
              asset={asset}
              openCase={openCaseByEquipment.get(asset.primaryId)}
            />
          ))}
        </ul>
      </QueryState>
    </div>
  )
}

function AssetCard({ asset, openCase }: { asset: EquipmentRow; openCase: string | undefined }) {
  return (
    <li>
      <Link
        to={`/equipment/${encodeURIComponent(asset.primaryId)}`}
        className="group flex h-full flex-col overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-raised)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="relative flex h-40 items-center justify-center bg-muted">
          <EquipmentPicture
            name={asset.properties.name}
            type={asset.properties.equipmentType}
            inset="p-5"
            className="transition-transform duration-500 group-hover:scale-[1.03]"
            iconClassName="size-12 text-foreground/35"
          />
          {openCase ? (
            <span className="absolute top-3 left-3 rounded-full bg-card/90 px-2.5 py-1 text-[12px] font-semibold shadow-sm backdrop-blur">
              {openCase} open
            </span>
          ) : null}
        </span>
        <span className="flex flex-1 flex-col gap-1.5 px-5 pt-4 pb-5">
          <span className="flex items-start justify-between gap-3">
            <span className="text-[18px] font-semibold tracking-[-0.015em] group-hover:text-primary">
              {asset.properties.name}
            </span>
            <StatusIndicator value={asset.properties.health} />
          </span>
          <span className="truncate text-[13.5px] text-muted-foreground">
            {humanize(asset.properties.equipmentType ?? "equipment")} ·{" "}
            {asset.links.facility?.properties.name ?? "Facility"}
          </span>
          <span className="mt-auto pt-2 text-[13px] text-foreground/70">
            {asset.properties.health === "healthy"
              ? `Reporting · ${formatRelativeTime(asset.properties.lastSeenAt)}`
              : humanize(asset.properties.healthReason ?? "readings_outside_range")}
          </span>
        </span>
      </Link>
    </li>
  )
}

function matchesView(asset: EquipmentRow, view: View): boolean {
  if (view === "attention") return asset.properties.health !== "healthy"
  if (view === "critical") return asset.properties.criticality === "critical"
  return true
}

function priority(asset: EquipmentRow): number {
  const health =
    { offline: 40, unhealthy: 30, watch: 20, healthy: 0 }[asset.properties.health ?? "healthy"] ?? 0
  const criticality =
    { critical: 6, important: 3, standard: 0 }[asset.properties.criticality ?? "standard"] ?? 0
  return health + criticality
}
