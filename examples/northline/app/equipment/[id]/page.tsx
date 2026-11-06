import { useObjectsQuery, useTelemetryHistoryQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, Radio } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { BuildingAlarm } from "../../../ontology/building-alarm"
import { Equipment } from "../../../ontology/equipment"
import { ServiceCase } from "../../../ontology/service-case"
import { TelemetryChart, type TelemetryPoint } from "../../_components/telemetry-chart"
import {
  CaseClockText,
  formatDate,
  formatRelativeTime,
  humanize,
  QueryState,
  Section,
  StatusBadge,
  StatusIndicator,
} from "../../_components/ui"
import { equipmentIcon, equipmentIllustration } from "../../_lib/equipment"

const alarmsQuery = objects(BuildingAlarm).query().expand(BuildingAlarm.l.equipment).limit(100)
const casesQuery = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.equipment)
  .limit(100)

export default function EquipmentDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const equipmentQuery = useMemo(
    () =>
      objects(Equipment)
        .query()
        .where((equipment) => equipment.p.id.eq(id))
        .expand(Equipment.l.facility),
    [id]
  )
  const equipmentResult = useObjectsQuery(equipmentQuery)
  const alarmsResult = useObjectsQuery(alarmsQuery)
  const casesResult = useObjectsQuery(casesQuery)
  const recent = { objectId: id, limit: 48, order: "desc" as const, enabled: Boolean(id) }
  const supply = useTelemetryHistoryQuery({
    objectType: Equipment,
    property: Equipment.p.supplyAirTemperature,
    ...recent,
  })
  const returnAir = useTelemetryHistoryQuery({
    objectType: Equipment,
    property: Equipment.p.returnAirTemperature,
    ...recent,
  })
  const current = useTelemetryHistoryQuery({
    objectType: Equipment,
    property: Equipment.p.compressorCurrent,
    ...recent,
  })

  const equipment = equipmentResult.data?.objects[0]
  const alarms = (alarmsResult.data?.objects ?? [])
    .filter((alarm) => alarm.links.equipment?.primaryId === id)
    .sort((left, right) => time(right.properties.observedAt) - time(left.properties.observedAt))
  const cases = (casesResult.data?.objects ?? [])
    .filter((serviceCase) => serviceCase.links.equipment?.primaryId === id)
    .sort((left, right) => time(right.properties.detectedAt) - time(left.properties.detectedAt))
  const activeCase = cases.find(
    (serviceCase) => !["closed", "cancelled"].includes(serviceCase.properties.status ?? "")
  )

  return (
    <QueryState
      loading={equipmentResult.isLoading}
      error={equipmentResult.isError}
      empty={!equipment}
      emptyMessage="Equipment not found."
    >
      {equipment ? (
        <div className="flex flex-col gap-6">
          <nav className="flex items-center gap-2 text-[14px] text-muted-foreground">
            <Link to="/equipment" className="text-primary hover:underline">
              Equipment
            </Link>
            <ChevronRight className="size-3.5" />
            <span>{equipment.properties.name}</span>
          </nav>

          <header className="flex flex-wrap items-stretch gap-7">
            <Hero name={equipment.properties.name} type={equipment.properties.equipmentType} />
            <div className="flex min-w-0 flex-[1_1_420px] flex-col justify-between gap-5 py-1">
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={equipment.properties.health} />
                  {equipment.properties.criticality === "critical" ? (
                    <StatusBadge value="critical" label="Critical asset" />
                  ) : null}
                </div>
                <h1 className="text-[40px] leading-none font-semibold tracking-[-0.035em] sm:text-[48px]">
                  {equipment.properties.name}
                </h1>
                <p className="text-[16px] text-muted-foreground">
                  {[equipment.properties.manufacturer, equipment.properties.model]
                    .filter(Boolean)
                    .join(" ")}{" "}
                  · {humanize(equipment.properties.equipmentType ?? "equipment")} at{" "}
                  {equipment.links.facility?.properties.name ?? "the facility"}
                </p>
              </div>
              <dl className="flex flex-wrap gap-x-9 gap-y-3">
                <Fact label="Signal">
                  <span className="inline-flex items-center gap-1.5">
                    <Radio
                      className={cn(
                        "size-3.5",
                        equipment.properties.health === "offline"
                          ? "text-muted-foreground"
                          : "text-[color:var(--success)]"
                      )}
                      strokeWidth={2}
                    />
                    {formatRelativeTime(equipment.properties.lastSeenAt)}
                  </span>
                </Fact>
                <Fact label="Serial">{equipment.properties.serialNumber ?? "—"}</Fact>
                <Fact label="Installed">
                  {formatDate(equipment.properties.installedOn)}
                  {equipment.properties.installedOn
                    ? ` · ${assetAge(equipment.properties.installedOn)}`
                    : ""}
                </Fact>
                <Fact label="Criticality">
                  {humanize(equipment.properties.criticality ?? "standard")}
                </Fact>
              </dl>
            </div>
          </header>

          {activeCase ? (
            <Link
              to={`/service-cases/${encodeURIComponent(activeCase.primaryId)}`}
              className="group flex items-center gap-4 rounded-[20px] bg-card px-6 py-4 shadow-[0_0_0_1.5px_var(--primary)] transition-shadow hover:shadow-[0_0_0_1.5px_var(--primary),0_10px_28px_color-mix(in_srgb,var(--primary)_12%,transparent)]"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[12px] font-semibold text-primary">Open service case</span>
                <span className="truncate text-[16px] font-semibold">
                  {activeCase.properties.number} · {activeCase.properties.title}
                </span>
                <span className="truncate text-[13.5px] text-muted-foreground">
                  {activeCase.links.customer?.properties.name} ·{" "}
                  <CaseClockText serviceCase={activeCase.properties} />
                </span>
              </span>
              <StatusBadge value={activeCase.properties.status} />
              <ChevronRight className="size-4 text-muted-foreground" />
            </Link>
          ) : null}

          <div className="flex flex-wrap items-start gap-5">
            <Section
              title="Readings"
              description="The last day from building controls, every half hour"
              className="min-w-0 flex-[999_1_560px]"
            >
              <div className="flex flex-col px-6 pb-4">
                <Reading
                  label="Supply air temperature"
                  unit="°C"
                  points={supply.data ?? []}
                  low={10}
                  high={19}
                />
                <Reading
                  label="Return air temperature"
                  unit="°C"
                  points={returnAir.data ?? []}
                  low={20}
                  high={25}
                />
                <Reading
                  label="Compressor current"
                  unit="A"
                  points={current.data ?? []}
                  low={8}
                  high={28}
                />
              </div>
            </Section>

            <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
              <Section
                title="Alarms"
                description={
                  equipment.properties.healthReason
                    ? humanize(equipment.properties.healthReason)
                    : undefined
                }
              >
                {alarms.length === 0 ? (
                  <p className="px-6 pb-6 text-[14px] text-muted-foreground">No alarms recorded.</p>
                ) : (
                  <ul className="px-6 pb-3">
                    {alarms.slice(0, 6).map((alarm) => (
                      <li
                        key={alarm.primaryId}
                        className="flex items-start justify-between gap-3 border-t border-border/70 py-3 first:border-t-0"
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[14.5px] leading-5 font-medium">
                            {alarm.properties.message}
                          </span>
                          <span className="text-[12.5px] text-muted-foreground">
                            {formatRelativeTime(alarm.properties.observedAt)} ·{" "}
                            {humanize(alarm.properties.status ?? "active")}
                          </span>
                        </span>
                        <StatusBadge value={alarm.properties.severity} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Service history">
                {cases.length === 0 ? (
                  <p className="px-6 pb-6 text-[14px] text-muted-foreground">No service cases.</p>
                ) : (
                  <ul className="px-6 pb-3">
                    {cases.map((serviceCase) => (
                      <li
                        key={serviceCase.primaryId}
                        className="border-t border-border/70 first:border-t-0"
                      >
                        <Link
                          to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
                          className="group flex items-center justify-between gap-3 py-3"
                        >
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate text-[14.5px] font-medium group-hover:text-primary">
                              {serviceCase.properties.number} · {serviceCase.properties.title}
                            </span>
                            <span className="text-[12.5px] text-muted-foreground">
                              {formatDate(serviceCase.properties.detectedAt)}
                            </span>
                          </span>
                          <StatusIndicator value={serviceCase.properties.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </aside>
          </div>
        </div>
      ) : null}
    </QueryState>
  )
}

function Hero({ name, type }: { name: string | undefined; type: string | undefined }) {
  const illustration = equipmentIllustration(name, type)
  const Icon = equipmentIcon(type)
  return (
    <div className="flex h-56 flex-[1_1_300px] items-center justify-center overflow-hidden rounded-[22px] bg-muted sm:max-w-[360px]">
      {illustration ? (
        <img
          src={illustration.src}
          alt={`${name ?? "Equipment"} illustration`}
          className={cn("size-full", illustration.contain ? "object-contain p-6" : "object-cover")}
        />
      ) : (
        <Icon className="size-16 text-foreground/40" strokeWidth={1.2} />
      )}
    </div>
  )
}

function Reading({
  label,
  unit,
  points,
  low,
  high,
}: {
  label: string
  unit: string
  points: readonly TelemetryPoint[]
  low: number
  high: number
}) {
  const latest = points.find((point) => typeof point.value === "number")?.value ?? null
  const state = latest === null ? "none" : latest > high ? "high" : latest < low ? "low" : "ok"
  return (
    <div className="flex flex-col gap-3 border-t border-border/70 py-5 first:border-t-0 first:pt-1">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium text-foreground/80">{label}</span>
          <span className="text-[30px] leading-9 font-semibold tracking-[-0.02em] tabular-nums">
            {latest === null ? "—" : `${latest.toFixed(1)} ${unit}`}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusIndicator
            value={state === "ok" ? "healthy" : state === "none" ? "unknown" : "unhealthy"}
            label={
              state === "ok"
                ? "Within range"
                : state === "high"
                  ? "Above range"
                  : state === "low"
                    ? "Below range"
                    : "Awaiting telemetry"
            }
          />
          <span className="text-[12.5px] text-muted-foreground">
            Expected {low}–{high} {unit}
          </span>
        </div>
      </div>
      <TelemetryChart
        points={points}
        unit={unit}
        expectedLow={low}
        expectedHigh={high}
        label={label}
      />
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[14.5px] font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function assetAge(value: string | Date): string {
  const years = (Date.now() - new Date(value).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
  if (years < 1) return "under a year"
  return `${Math.floor(years)} yr`
}

function time(value: string | Date | undefined): number {
  if (!value) return 0
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}
